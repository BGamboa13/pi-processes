import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  attentionToSendOptions,
  sendProcessNotificationMessage,
} from "./notification-sender";
import type { ProcessNotificationDetails } from "./notifications/types";

/** How long a wake we sent may take to start its run before we stop trusting it. */
const WAKE_START_WINDOW_MS = 30_000;
/** How long a user prompt seen at `input` may take to start its run. */
const INPUT_START_WINDOW_MS = 2_000;
/** Bounded re-check for held notifications when the host emits no boundary event. */
const HELD_RECHECK_MS = 1_000;

/**
 * Text of the prompt that wakes an idle agent. The notification itself is
 * already stored as a `nextTurn` message and arrives with this prompt, so the
 * text only has to say where the turn came from.
 */
export const WAKE_PROMPT =
  "[Automated notice from pi-processes, not written by the user] A background process needs your attention. Its notification is attached to this message.";

export interface TurnNotificationDelivery {
  /** Delivers a `turn`-attention notification according to the host state. */
  deliver(details: ProcessNotificationDetails): void;
  /** Stops timers and ignores later events. */
  dispose(): void;
}

/**
 * Routes `turn` notifications by what the Pi host is doing.
 *
 * `sendMessage({ triggerTurn: true })` on an idle host starts the run directly
 * and skips `before_agent_start`, so the woken turn misses every system-prompt
 * addition other extensions make there (earendil-works/pi#5581). The same
 * direct run starts in the middle of manual compaction or branch summarization,
 * which are busy without a run.
 *
 * - run active: steer, as before.
 * - idle: store the notification for the next prompt (`nextTurn`) and wake the
 *   agent once with `sendUserMessage`, which goes through `prompt()` and
 *   therefore through `before_agent_start`.
 * - busy without a run: hold in memory until the host reports a boundary.
 * - between `before_agent_start` and `agent_start`: hold too. The prompt has
 *   already drained the host's `nextTurn` list while the host still reads idle,
 *   so a stored notification would wait for the next prompt; held items join
 *   the run as steers at `agent_start`, or take the idle path if the prompt
 *   never starts one (the window expires; the held re-check picks them up).
 * - no usable context: original `sendMessage` call, never strand.
 *
 * Needs `agent_settled` (Pi 0.80.4+) to see the end of a run; without it the run
 * is considered active from `agent_start` on and every notification is steered
 * as before.
 */
export function createTurnNotificationDelivery(
  pi: ExtensionAPI,
): TurnNotificationDelivery {
  let disposed = false;
  let ctx: ExtensionContext | undefined;
  let runActive = false;
  /** Epoch ms until which a prompt is known to be starting a run. */
  let startWindowUntil = 0;
  /**
   * Epoch ms until which a prompt is past `before_agent_start` but has not
   * reached `agent_start`. The host already drained its `nextTurn` list and
   * still reports idle, so a notification stored now would be stranded.
   */
  let promptStartingUntil = 0;
  let wakeScheduled = false;
  let held: ProcessNotificationDetails[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer) clearTimeout(timer);
  };

  const sendOriginal = (details: ProcessNotificationDetails) => {
    sendProcessNotificationMessage(
      pi,
      details,
      attentionToSendOptions(details.attention),
    );
  };

  const isIdle = (): boolean | undefined => {
    if (!ctx) return undefined;
    try {
      return ctx.isIdle();
    } catch {
      // Stale context after a session replacement.
      return undefined;
    }
  };

  const openStartWindow = (ms: number) => {
    startWindowUntil = Math.max(startWindowUntil, Date.now() + ms);
  };

  const startWindowOpen = () => Date.now() < startWindowUntil;
  const promptStarting = () => Date.now() < promptStartingUntil;

  const armRecheck = () => {
    if (recheckTimer || held.length === 0) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      flushHeld();
    }, HELD_RECHECK_MS);
    recheckTimer.unref?.();
  };

  const scheduleWake = () => {
    if (wakeScheduled) return;
    wakeScheduled = true;
    queueMicrotask(() => {
      wakeScheduled = false;
      if (disposed || runActive || startWindowOpen()) return;
      if (isIdle() !== true) return;
      openStartWindow(WAKE_START_WINDOW_MS);
      try {
        pi.sendUserMessage(WAKE_PROMPT);
      } catch {
        // Stored notifications still reach the next prompt.
        startWindowUntil = 0;
      }
    });
  };

  const route = (details: ProcessNotificationDetails) => {
    const idle = isIdle();
    if (idle === undefined || runActive) {
      sendOriginal(details);
      return;
    }
    if (idle && !promptStarting()) {
      sendProcessNotificationMessage(pi, details, {
        triggerTurn: false,
        deliverAs: "nextTurn",
      });
      scheduleWake();
      return;
    }
    held.push(details);
    armRecheck();
  };

  function flushHeld() {
    clearTimer(recheckTimer);
    recheckTimer = null;
    const items = held;
    held = [];
    // `route` re-holds (and re-arms the re-check) while the host stays busy.
    for (const details of items) route(details);
  }

  // The host still reports busy inside compaction/tree handlers and at
  // agent_settled, so flush on the next tick.
  const scheduleFlush = () => {
    if (flushTimer || held.length === 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!disposed) flushHeld();
    }, 0);
    flushTimer.unref?.();
  };

  const track = (context: ExtensionContext) => {
    ctx = context;
  };

  pi.on("session_start", (_event, context) => {
    if (disposed) return;
    track(context);
    // Held notifications belong to the previous session and are dropped.
    held = [];
    clearTimer(flushTimer);
    clearTimer(recheckTimer);
    flushTimer = null;
    recheckTimer = null;
    runActive = false;
    startWindowUntil = 0;
    promptStartingUntil = 0;
  });
  pi.on("input", (event, context) => {
    if (disposed) return;
    track(context);
    if (!event.streamingBehavior) openStartWindow(INPUT_START_WINDOW_MS);
  });
  pi.on("before_agent_start", (_event, context) => {
    if (disposed) return;
    track(context);
    openStartWindow(WAKE_START_WINDOW_MS);
    if (!runActive) promptStartingUntil = Date.now() + WAKE_START_WINDOW_MS;
  });
  pi.on("agent_start", (_event, context) => {
    if (disposed) return;
    track(context);
    runActive = true;
    startWindowUntil = 0;
    promptStartingUntil = 0;
    // The run is active now: held notifications join it as steers.
    flushHeld();
  });
  pi.on("turn_end", (_event, context) => {
    if (!disposed) track(context);
  });
  pi.on("agent_end", (_event, context) => {
    if (!disposed) track(context);
  });
  pi.on("agent_settled", (_event, context) => {
    if (disposed) return;
    track(context);
    runActive = false;
    scheduleFlush();
  });
  pi.on("session_compact", (_event, context) => {
    if (disposed) return;
    track(context);
    scheduleFlush();
  });
  pi.on("session_tree", (_event, context) => {
    if (disposed) return;
    track(context);
    scheduleFlush();
  });

  return {
    deliver(details) {
      if (disposed) return;
      route(details);
    },
    dispose() {
      disposed = true;
      held = [];
      clearTimer(flushTimer);
      clearTimer(recheckTimer);
      flushTimer = null;
      recheckTimer = null;
    },
  };
}
