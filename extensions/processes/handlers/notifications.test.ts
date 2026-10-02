import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ProcessProtocolNotificationPayload } from "../../shared/protocol";
import { CHANNELS } from "../../shared/protocol";
import { MESSAGE_TYPE_PROCESS_NOTIFICATION } from "../constants";
import { registerNotificationDelivery } from "./notifications";

function makePayload(
  overrides: Partial<ProcessProtocolNotificationPayload> = {},
): ProcessProtocolNotificationPayload {
  return {
    kind: "failure",
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
    ...overrides,
  };
}

function piWithSendMessage(sendMessage: ReturnType<typeof vi.fn>) {
  return { sendMessage, sendUserMessage: vi.fn(), on: vi.fn() } as never;
}

/** A fake pi whose lifecycle handlers can be fired with a fake context. */
function hostedPi(idle: boolean) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const sendMessage = vi.fn();
  const sendUserMessage = vi.fn();
  const pi = {
    sendMessage,
    sendUserMessage,
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) =>
      handlers.set(event, handler),
  } as never;
  const startSession = () =>
    handlers.get("session_start")?.(
      { type: "session_start" },
      {
        isIdle: () => idle,
      },
    );
  return { pi, sendMessage, sendUserMessage, startSession };
}

describe("registerNotificationDelivery", () => {
  it("sends a displayed custom message with attention-derived options", () => {
    const events = createEventBus();
    const sendMessage = vi.fn();
    registerNotificationDelivery(events, piWithSendMessage(sendMessage));

    events.emit(CHANNELS.NOTIFICATION, makePayload({ attention: "turn" }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = sendMessage.mock.calls[0];
    expect(message.customType).toBe(MESSAGE_TYPE_PROCESS_NOTIFICATION);
    expect(message.display).toBe(true);
    expect(message.details.attention).toBe("turn");
    expect(options.triggerTurn).toBe(true);
    expect(options.deliverAs).toBe("steer");
  });

  // Regression: idle `turn` notifications woke the agent without before_agent_start (#121).
  it("routes a turn notification to nextTurn plus one prompt wake on an idle host", async () => {
    const events = createEventBus();
    const host = hostedPi(true);
    registerNotificationDelivery(events, host.pi);
    host.startSession();

    events.emit(CHANNELS.NOTIFICATION, makePayload({ attention: "turn" }));
    events.emit(
      CHANNELS.NOTIFICATION,
      makePayload({ attention: "turn", processId: "proc_2" }),
    );
    await Promise.resolve();

    expect(host.sendMessage).toHaveBeenCalledTimes(2);
    for (const [, options] of host.sendMessage.mock.calls) {
      expect(options).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
    }
    expect(host.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["context", "ignore"] as const)(
    "keeps %s attention as nextTurn without waking an idle host",
    async (attention) => {
      const events = createEventBus();
      const host = hostedPi(true);
      registerNotificationDelivery(events, host.pi);
      host.startSession();

      events.emit(CHANNELS.NOTIFICATION, makePayload({ attention }));
      await Promise.resolve();

      expect(host.sendMessage.mock.calls[0][1]).toEqual({
        triggerTurn: false,
        deliverAs: "nextTurn",
      });
      expect(host.sendUserMessage).not.toHaveBeenCalled();
    },
  );

  it("maps context attention to a non-turn nextTurn message", () => {
    const events = createEventBus();
    const sendMessage = vi.fn();
    registerNotificationDelivery(events, piWithSendMessage(sendMessage));

    events.emit(CHANNELS.NOTIFICATION, makePayload({ attention: "context" }));

    const [, options] = sendMessage.mock.calls[0];
    expect(options.triggerTurn).toBe(false);
    expect(options.deliverAs).toBe("nextTurn");
  });

  it("stops delivering after the disposer is called", () => {
    const events = createEventBus();
    const sendMessage = vi.fn();
    const dispose = registerNotificationDelivery(
      events,
      piWithSendMessage(sendMessage),
    );

    dispose();
    events.emit(CHANNELS.NOTIFICATION, makePayload());

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("caps log-match delivery, summarizes suppression, and exempts lifecycle events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const events = createEventBus();
    const sendMessage = vi.fn();
    const dispose = registerNotificationDelivery(
      events,
      piWithSendMessage(sendMessage),
    );

    for (let index = 0; index < 30; index++) {
      events.emit(
        CHANNELS.NOTIFICATION,
        makePayload({ kind: "log_match", attention: "turn" }),
      );
    }
    expect(sendMessage).toHaveBeenCalledTimes(20);

    events.emit(CHANNELS.NOTIFICATION, makePayload({ kind: "crash" }));
    expect(sendMessage).toHaveBeenCalledTimes(21);
    expect(sendMessage.mock.calls.at(-1)?.[0].details.kind).toBe("crash");

    vi.advanceTimersByTime(60_000);
    expect(sendMessage).toHaveBeenCalledTimes(22);
    const [summary, options] = sendMessage.mock.calls.at(-1) ?? [];
    expect(summary.details).toEqual(
      expect.objectContaining({
        kind: "log_match_suppressed",
        summary: expect.stringContaining("Suppressed 10"),
        attention: "context",
      }),
    );
    expect(options).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });

    dispose();
    vi.useRealTimers();
  });
});

type HostRequest = { systemPrompt?: string; messages: unknown[] };

/**
 * The request a provider received. Pi up to 0.99 passes the system prompt as
 * `context.systemPrompt`; Pi 1.0 carries it as leading `role: "system"`
 * messages in the transcript. Both are read so the test runs on either.
 */
function toHostRequest(context: {
  systemPrompt?: string;
  messages: unknown[];
}): HostRequest {
  const system: string[] = [];
  const messages: unknown[] = [];
  for (const message of context.messages) {
    const m = message as { role?: string; content?: unknown };
    if (m.role !== "system") {
      messages.push(message);
      continue;
    }
    const content = Array.isArray(m.content) ? m.content : [m.content];
    for (const part of content) {
      if (typeof part === "string") system.push(part);
      else if (part && typeof (part as { text?: unknown }).text === "string")
        system.push((part as { text: string }).text);
    }
  }
  const systemPrompt =
    context.systemPrompt ?? (system.length > 0 ? system.join("\n") : undefined);
  return { systemPrompt, messages };
}

/**
 * A real AgentSession with pi-processes delivery registered, a probe that
 * appends PROBE_MARKER in `before_agent_start`, and an optional extension
 * registered after it (so its handlers run later in the same event).
 */
// The root setup mocks node:fs with memfs; the real host needs the real one.
const realFs = () => vi.importActual<typeof FsPromises>("node:fs/promises");

async function createRealHost(
  registerLater?: (pi: ExtensionAPI) => void,
): Promise<{
  session: AgentSession;
  requests: HostRequest[];
  runs: () => number;
  emitNotification: (payload: ProcessProtocolNotificationPayload) => void;
  settled: Promise<void>;
  dispose: () => Promise<void>;
}> {
  const faux = fauxProvider();
  const requests: HostRequest[] = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (context: HostRequest) => {
      requests.push(toHostRequest(context));
      return fauxAssistantMessage("noted");
    }),
  );

  let emitNotification = (_payload: ProcessProtocolNotificationPayload) => {};
  let runs = 0;
  let settle = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const cwd = process.cwd();
  const fs = await realFs();
  const agentDir = await fs.mkdtemp(join(tmpdir(), "pi-processes-idle-wake-"));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.registerProvider(faux.provider);
        pi.on("agent_start", () => {
          runs++;
        });
        pi.on("agent_settled", () => settle());
        registerNotificationDelivery(pi.events, pi);
        emitNotification = (payload) =>
          pi.events.emit(CHANNELS.NOTIFICATION, payload);
        // Stands in for any extension that shapes the system prompt.
        pi.on("before_agent_start", (event) => ({
          systemPrompt: `${event.systemPrompt}\nPROBE_MARKER`,
        }));
        registerLater?.(pi);
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: await ModelRuntime.create({
      authPath: `${agentDir}/auth.json`,
      modelsPath: null,
    }),
    model: faux.getModel(),
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    noTools: "all",
  });
  await session.bindExtensions({});
  return {
    session,
    requests,
    runs: () => runs,
    emitNotification: (payload) => emitNotification(payload),
    settled,
    dispose: async () => {
      session.dispose();
      await fs.rm(agentDir, { recursive: true, force: true });
    },
  };
}

const countProcessEvents = (messages: unknown[]) =>
  JSON.stringify(messages).match(/process_id=/g)?.length ?? 0;

// Regression: idle `turn` notifications woke the agent without before_agent_start (#121).
describe("registerNotificationDelivery on a real Pi host", () => {
  it("wakes an idle host through a prompt so before_agent_start still runs", async () => {
    const host = await createRealHost();

    host.emitNotification(makePayload({ attention: "turn" }));
    await host.settled;

    expect(host.requests).toHaveLength(1);
    expect(
      host.requests[0].systemPrompt ?? "",
      "the woken request carries what before_agent_start added",
    ).toContain("PROBE_MARKER");
    expect(countProcessEvents(host.requests[0].messages)).toBe(1);
    expect(JSON.stringify(host.requests[0].messages)).toContain(
      "not written by the user",
    );
    await host.dispose();
  });

  it("joins the starting run when the notification arrives after before_agent_start drained nextTurn", async () => {
    let parked: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      parked = resolve;
    });
    let reachedBarrier: () => void = () => {};
    const atBarrier = new Promise<void>((resolve) => {
      reachedBarrier = resolve;
    });
    const host = await createRealHost((pi) => {
      pi.on("before_agent_start", async () => {
        reachedBarrier();
        await gate;
      });
    });

    const prompt = host.session.prompt("user prompt");
    await atBarrier;
    host.emitNotification(makePayload({ attention: "turn" }));
    parked();
    await prompt;
    await host.settled;
    // Let any stray wake start its run before asserting there is none.
    await new Promise((resolve) => setImmediate(resolve));

    expect(host.runs(), "exactly one run, no extra wake run").toBe(1);
    const last = host.requests.at(-1);
    expect(
      last?.systemPrompt ?? "",
      "the run carries what before_agent_start added",
    ).toContain("PROBE_MARKER");
    expect(
      countProcessEvents(last?.messages ?? []),
      "the notification joins the starting run exactly once",
    ).toBe(1);
    expect(JSON.stringify(last?.messages)).not.toContain(
      "not written by the user",
    );
    await host.dispose();
  });
});
