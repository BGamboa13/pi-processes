// Regression: idle `turn` notifications woke the agent without before_agent_start (#121).
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTurnNotificationDelivery, WAKE_PROMPT } from "./idle-wake";
import type { ProcessNotificationDetails } from "./notifications/types";

type Handler = (event: unknown, ctx: ExtensionContext) => void;

const details: ProcessNotificationDetails = {
  kind: "crash",
  processId: "proc_1",
  processName: "dev",
  command: "pnpm dev",
  timestamp: 123,
  summary: "Process failed.",
  status: "exited",
  exitCode: 1,
  endReason: "exit",
  signal: null,
  attention: "turn",
};

const STEER = { triggerTurn: true, deliverAs: "steer" };
const NEXT_TURN = { triggerTurn: false, deliverAs: "nextTurn" };

function setup() {
  const handlers = new Map<string, Handler>();
  const sendMessage = vi.fn();
  const sendUserMessage = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    sendMessage,
    sendUserMessage,
  };
  const host = { idle: true, stale: false };
  const ctx = {
    isIdle: () => {
      if (host.stale) throw new Error("This extension ctx is stale");
      return host.idle;
    },
  } as unknown as ExtensionContext;
  const delivery = createTurnNotificationDelivery(pi as never);
  const emit = (event: string, payload: object = {}) =>
    handlers.get(event)?.({ type: event, ...payload }, ctx);
  const optionsOf = () => sendMessage.mock.calls.map((call) => call[1]);
  return { delivery, emit, host, sendMessage, sendUserMessage, optionsOf };
}

/** Lets the wake microtask run. */
const flushMicrotasks = () => Promise.resolve();

describe("createTurnNotificationDelivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("idle host", () => {
    it("stores the notification as nextTurn and wakes once through a prompt", async () => {
      const t = setup();
      t.emit("session_start");

      t.delivery.deliver(details);
      await flushMicrotasks();

      expect(t.optionsOf()).toEqual([NEXT_TURN]);
      expect(t.sendMessage.mock.calls[0][0].details).toBe(details);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(t.sendUserMessage).toHaveBeenCalledWith(WAKE_PROMPT);
      expect(WAKE_PROMPT).toContain("not written by the user");
      expect(WAKE_PROMPT).not.toContain(details.summary);
    });

    it("shares one wake between notifications in the same pass", async () => {
      const t = setup();
      t.emit("session_start");

      t.delivery.deliver(details);
      t.delivery.deliver({ ...details, processId: "proc_2" });
      await flushMicrotasks();

      expect(t.optionsOf()).toEqual([NEXT_TURN, NEXT_TURN]);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("sends no second wake while the first one is starting", async () => {
      const t = setup();
      t.emit("session_start");

      t.delivery.deliver(details);
      await flushMicrotasks();
      t.delivery.deliver(details);
      await flushMicrotasks();

      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(t.optionsOf()).toEqual([NEXT_TURN, NEXT_TURN]);
    });

    it("wakes again once the woken run settles", async () => {
      const t = setup();
      t.emit("session_start");
      t.delivery.deliver(details);
      await flushMicrotasks();
      t.emit("before_agent_start");
      t.emit("agent_start");
      t.emit("agent_settled");

      t.delivery.deliver(details);
      await flushMicrotasks();

      expect(t.sendUserMessage).toHaveBeenCalledTimes(2);
    });

    it("lets a wake out after the wake start window expires", async () => {
      const t = setup();
      t.emit("session_start");
      t.delivery.deliver(details);
      await flushMicrotasks();

      vi.advanceTimersByTime(30_001);
      t.delivery.deliver(details);
      await flushMicrotasks();

      expect(t.sendUserMessage).toHaveBeenCalledTimes(2);
    });

    it("wakes once after the input window expires when that input never starts a run", async () => {
      const t = setup();
      t.emit("session_start");
      t.emit("input", { source: "interactive" });

      t.delivery.deliver(details);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(t.sendUserMessage).not.toHaveBeenCalled();
      expect(t.optionsOf()).toEqual([NEXT_TURN]);

      await vi.advanceTimersByTimeAsync(2);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("sends no wake after expiry when a prompt reached before_agent_start and carried the notification", async () => {
      const t = setup();
      t.emit("session_start");
      t.emit("input", { source: "interactive" });
      t.delivery.deliver(details);

      t.emit("before_agent_start");
      t.emit("agent_start");
      t.emit("agent_settled");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(t.sendUserMessage).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("re-wakes once per window while the wake's prompt never reaches before_agent_start", async () => {
      const t = setup();
      t.emit("session_start");
      t.delivery.deliver(details);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(29_000);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(2);

      t.emit("before_agent_start");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(2);
    });

    it("wakes after a run that never drained nextTurn settles", async () => {
      const t = setup();
      t.emit("session_start");
      t.emit("input", { source: "interactive" });
      t.delivery.deliver(details);
      await flushMicrotasks();
      expect(t.optionsOf()).toEqual([NEXT_TURN]);
      expect(t.sendUserMessage).not.toHaveBeenCalled();

      // Another extension starts a run directly (sendMessage with triggerTurn),
      // which skips prompt() and before_agent_start, so nextTurn is not drained.
      t.emit("agent_start");
      t.emit("agent_settled");
      await vi.advanceTimersByTimeAsync(0);

      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("keeps an owed wake when the host is busy without a run at expiry", async () => {
      const t = setup();
      t.emit("session_start");
      t.emit("input", { source: "interactive" });
      t.delivery.deliver(details);
      await flushMicrotasks();

      // The input never starts a run and the host is compacting when the
      // start window expires.
      t.host.idle = false;
      await vi.advanceTimersByTimeAsync(2_001);
      expect(t.sendUserMessage).not.toHaveBeenCalled();

      t.host.idle = true;
      await vi.advanceTimersByTimeAsync(1_001);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("stops after three unconfirmed wakes and resumes once a prompt starts", async () => {
      const t = setup();
      t.emit("session_start");
      t.delivery.deliver(details);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10 * 31_000);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(3);

      // A user prompt carries the stored notification and resets the count.
      t.emit("before_agent_start");
      t.emit("agent_start");
      t.emit("agent_settled");
      t.delivery.deliver(details);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(4);
    });

    it("keeps the notification stored and wakes again at expiry when sendUserMessage throws", async () => {
      const t = setup();
      t.emit("session_start");
      t.sendUserMessage.mockImplementationOnce(() => {
        throw new Error("Agent is already processing");
      });

      t.delivery.deliver(details);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.optionsOf()).toEqual([NEXT_TURN]);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_001);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(2);
    });

    it("ignores queued input that has a streamingBehavior", async () => {
      const t = setup();
      t.emit("session_start");
      t.emit("input", { source: "interactive", streamingBehavior: "steer" });

      t.delivery.deliver(details);
      await flushMicrotasks();

      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("does not shorten the wake window when the wake's own input arrives", async () => {
      const t = setup();
      t.emit("session_start");
      t.delivery.deliver(details);
      await flushMicrotasks();
      t.emit("input", { source: "extension" });

      vi.advanceTimersByTime(5_000);
      t.delivery.deliver(details);
      await flushMicrotasks();

      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("does not wake when a run started before the wake microtask", async () => {
      const t = setup();
      t.emit("session_start");

      t.delivery.deliver(details);
      t.emit("agent_start");
      await flushMicrotasks();

      expect(t.optionsOf()).toEqual([NEXT_TURN]);
      expect(t.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  describe("prompt between before_agent_start and agent_start", () => {
    it("holds, then steers into the run at agent_start", async () => {
      const t = setup();
      t.emit("session_start");
      t.emit("before_agent_start");

      t.delivery.deliver(details);
      await flushMicrotasks();
      expect(t.sendMessage).not.toHaveBeenCalled();
      expect(t.sendUserMessage).not.toHaveBeenCalled();

      t.host.idle = false;
      t.emit("agent_start");

      expect(t.optionsOf()).toEqual([STEER]);
      expect(t.sendUserMessage).not.toHaveBeenCalled();
    });

    it("takes the idle path with one wake when no run starts before the window expires", async () => {
      const t = setup();
      t.emit("session_start");
      t.emit("before_agent_start");
      t.delivery.deliver(details);

      await vi.advanceTimersByTimeAsync(29_000);
      expect(t.sendMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);

      expect(t.optionsOf()).toEqual([NEXT_TURN]);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("drops the held notification on session_start", async () => {
      const t = setup();
      t.emit("session_start");
      t.emit("before_agent_start");
      t.delivery.deliver(details);

      t.emit("session_start");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(t.sendMessage).not.toHaveBeenCalled();
      expect(t.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  describe("active run", () => {
    it("steers with the original options and never wakes", async () => {
      const t = setup();
      t.emit("session_start");
      t.host.idle = false;
      t.emit("agent_start");

      t.delivery.deliver(details);
      await flushMicrotasks();

      expect(t.optionsOf()).toEqual([STEER]);
      expect(t.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  describe("busy without a run", () => {
    it("holds until session_compact, then routes by the new state", async () => {
      const t = setup();
      t.emit("session_start");
      t.host.idle = false;

      t.delivery.deliver(details);
      await flushMicrotasks();
      expect(t.sendMessage).not.toHaveBeenCalled();

      t.emit("session_compact");
      t.host.idle = true;
      await vi.advanceTimersByTimeAsync(0);

      expect(t.optionsOf()).toEqual([NEXT_TURN]);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it.each(["session_tree", "agent_settled"])(
      "flushes on %s",
      async (event) => {
        const t = setup();
        t.emit("session_start");
        t.host.idle = false;
        t.delivery.deliver(details);

        t.emit(event);
        t.host.idle = true;
        await vi.advanceTimersByTimeAsync(0);

        expect(t.optionsOf()).toEqual([NEXT_TURN]);
      },
    );

    it("re-checks after a bounded delay when no event arrives", async () => {
      const t = setup();
      t.emit("session_start");
      t.host.idle = false;
      t.delivery.deliver(details);

      await vi.advanceTimersByTimeAsync(999);
      expect(t.sendMessage).not.toHaveBeenCalled();

      // The cancelled operation emitted nothing; the host is simply idle now.
      t.host.idle = true;
      await vi.advanceTimersByTimeAsync(1);

      expect(t.optionsOf()).toEqual([NEXT_TURN]);
      expect(t.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("keeps holding while the host stays busy and stops re-checking after delivery", async () => {
      const t = setup();
      t.emit("session_start");
      t.host.idle = false;
      t.delivery.deliver(details);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(t.sendMessage).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      t.host.idle = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(t.sendMessage).toHaveBeenCalledTimes(1);
      // Only the wake retry timer is left; the held re-check stopped.
      t.emit("before_agent_start");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("arms no re-check when nothing is held", async () => {
      const t = setup();
      t.emit("session_start");
      t.delivery.deliver(details);
      await flushMicrotasks();
      // The prompt carrying the stored notification cancels the wake retry.
      t.emit("before_agent_start");
      t.emit("session_compact");

      expect(vi.getTimerCount()).toBe(0);
    });

    it("drops held notifications and cancels the re-check on session change", async () => {
      const t = setup();
      t.emit("session_start");
      t.host.idle = false;
      t.delivery.deliver(details);
      expect(vi.getTimerCount()).toBe(1);

      t.emit("session_start");
      t.host.idle = true;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(vi.getTimerCount()).toBe(0);
      expect(t.sendMessage).not.toHaveBeenCalled();
      expect(t.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  describe("unusable context", () => {
    it("falls back to the original call before any context is known", async () => {
      const t = setup();

      t.delivery.deliver(details);
      await flushMicrotasks();

      expect(t.optionsOf()).toEqual([STEER]);
      expect(t.sendUserMessage).not.toHaveBeenCalled();
    });

    it("falls back to the original call when the context is stale", async () => {
      const t = setup();
      t.emit("session_start");
      t.host.stale = true;

      t.delivery.deliver(details);
      await flushMicrotasks();

      expect(t.optionsOf()).toEqual([STEER]);
      expect(t.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  it("stops everything after dispose", async () => {
    const t = setup();
    t.emit("session_start");
    t.host.idle = false;
    t.delivery.deliver(details);

    t.delivery.dispose();
    t.host.idle = true;
    await vi.advanceTimersByTimeAsync(5_000);
    t.delivery.deliver(details);
    await flushMicrotasks();

    expect(t.sendMessage).not.toHaveBeenCalled();
    expect(t.sendUserMessage).not.toHaveBeenCalled();
  });
});
