# Process notifications

This document describes how process lifecycle and log-watch events become
notifications that reach the agent, which user options control each path, and
which paths bypass user config. It covers the event flow only — UI rendering
(`/ps`, dock, logs overlay) is out of scope.

There are two layers:

1. **NotificationService** (`extensions/processes/notifications/service.ts`)
   listens to the `ProcessManager` event bus, classifies the end, resolves an
   attention level, and emits a language-neutral payload on
   `CHANNELS.NOTIFICATION`.
2. **Delivery listener** (`extensions/processes/handlers/notifications.ts`)
   subscribes to `CHANNELS.NOTIFICATION`, applies log-match rate limiting, and
   converts each payload into a persisted Pi custom message via
   `sendProcessNotificationMessage`.

UI extensions (`processes-logs`, `processes-dock`) also observe
`CHANNELS.NOTIFICATION` for display concerns (e.g. log-match highlighting) but
do not affect delivery.

### Delivery timing

`turn` notifications are routed by what the Pi host is doing
(`createTurnNotificationDelivery` in `extensions/processes/idle-wake.ts`, called
from `registerNotificationDelivery`). The state comes from the latest extension
context, tracked from `session_start`, `input`, `before_agent_start`,
`agent_start`, `turn_end`, `agent_end`, `agent_settled`, `session_compact` and
`session_tree`.

| Host state                                                                        | Delivery                                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run active (`agent_start` .. `agent_settled`)                                     | `sendMessage` with `{ triggerTurn: true, deliverAs: "steer" }`: the notification reaches the run after its current tool calls finish.                  |
| Idle                                                                              | `sendMessage` with `{ triggerTurn: false, deliverAs: "nextTurn" }`, then one `sendUserMessage` wake that says it is an automated process notification. |
| Busy without a run (manual or threshold compaction, `/tree` branch summarization) | Held in memory, then routed as above once the host is idle or running.                                                                                 |
| Prompt starting (after `before_agent_start`, before `agent_start`)                | Held, then sent with the steer options at `agent_start` so it joins that run. If no run starts within 30 s, it takes the idle path.                    |
| No usable context (none seen yet, or stale after a session replacement)           | The original `sendMessage` call with the steer options, so a notification is never stranded.                                                           |

Why the idle path does not use `triggerTurn: true`: Pi's `sendCustomMessage`
starts a run directly when the host is not streaming, which skips
`before_agent_start` (earendil-works/pi#5581). The woken turn would then lack
every system-prompt addition other extensions make in that hook. A prompt goes
through `before_agent_start`, and Pi delivers `nextTurn` messages together with
the next prompt, so the notification appears in the woken turn exactly once and
the wake text does not repeat it.

Why a starting prompt holds: `prompt()` drains the host's `nextTurn` list right
around `before_agent_start` (just before it up to Pi 0.86, just after it from
0.87), but the host only reports a run as active from `agent_start`. In between
it still reads idle, so a notification stored as `nextTurn` there can miss the
drain and wait for the next prompt with nothing to wake it. Between those two events `turn` notifications are held instead.
A user prompt seen at `input` is different: its `nextTurn` drain is still ahead,
so notifications stored in that gap arrive with that prompt.

The direct start that `triggerTurn: true` performs would also begin a run in the
middle of a compaction or branch summarization, which is why those states hold
too.

Wake coalescing: notifications delivered in the same synchronous pass share one
wake. While a wake is starting, no second one is sent. A prompt seen at
`before_agent_start` (30 s window) or a user prompt seen at `input` without a
`streamingBehavior` (2 s window) also counts as starting. A window never gets
shorter, so the wake's own `input` event cannot shrink it, and it expires so a
prompt that never starts a run cannot suppress wakes forever.

A wake is owed from the moment a notification is stored as `nextTurn` until a
prompt reaches `before_agent_start`; that prompt is the one that drains the list
(in every Pi version only `prompt()` drains it, never a run started directly). If a
wake is suppressed by an open start window (for example a user `input` that
never starts a run, such as a slash command another extension handles), one
timer re-runs it just after the window expires. A wake whose prompt never
reaches `before_agent_start` is therefore repeated at most once per 30 s while
the notification is still owed, never in a tight loop, and at most three times
in a row: after that the notification stays stored and the next prompt carries
it. The count resets at `before_agent_start`. If the host is busy without a run
when the wake is due, it is re-checked every second, like held notifications,
and a run that settles without draining `nextTurn` (one started directly by
another extension) schedules the wake. The timer is cancelled at
`before_agent_start`, `agent_start`, `session_start` and on dispose.

Held notifications are flushed on the next tick after `session_compact`,
`session_tree` and `agent_settled` (the host still reports busy inside those
handlers). While anything is held, a 1 s re-check also runs, so a cancelled
operation that emits no event cannot strand it; the re-check is not armed when
nothing is held. Held notifications are dropped on `session_start`, because they
belong to the previous session.

Pi version notes: `agent_settled` exists from Pi 0.80.4. On Pi 0.80.3 the end of
a run is never seen, so every `turn` notification is steered as before (the
previous behavior, including its idle-wake limitation). There is no
`session_compact_failed` event in the Pi versions this package is tested
against, so a failed or cancelled compaction is covered by the 1 s re-check.

Deferring non-turn notifications also preserves tool-call ordering. Appending a
custom message during tool execution would place it between the assistant
`tool_use` and its `tool_result`, which Anthropic rejects.

## Per-process notify config

Registered by the `process start` and `process update` tools
(`normalizeNotifyConfig` in `extensions/processes/tools/notify.ts`):

| Field        | Type                              | Default   |
| ------------ | --------------------------------- | --------- |
| `onSuccess`  | `"turn"` \| `"context"` \| `"ignore"` | `"turn"`  |
| `onFailure`  | `"turn"` \| `"context"` \| `"ignore"` | `"turn"`  |
| `onKilled`   | `"turn"` \| `"context"` \| `"ignore"` | `"context"` |
| `logMatches` | `LogMatcherConfig[]`              | `[]`      |

Each `LogMatcherConfig`:

| Field    | Type                              | Default   |
| -------- | --------------------------------- | --------- |
| `pattern` | `string` (≤500 chars, non-empty) | required  |
| `mode`   | `"literal"` \| `"regex"`          | `"literal"` |
| `stream` | `"stdout"` \| `"stderr"` \| `"both"` | `"both"`  |
| `repeat` | `boolean`                         | `false`   |
| `on`     | `"turn"` \| `"context"` \| `"ignore"` | `"turn"`  |

There are no global settings that affect notifications. The extension config
(`ProcessConfig` in `extensions/processes/config/types.ts`) only covers
execution, output retention, and UI — none of it changes attention or delivery.

## Attention levels

An attention level is resolved per event and mapped to Pi send options by
`attentionToSendOptions` (`extensions/processes/notification-sender.ts`):

| Attention | `triggerTurn` | `deliverAs` | Agent effect                                                                                                                                            |
| --------- | ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn`    | `true`        | `steer`     | Steers an active run after its current tool calls. On an idle host it is stored as `nextTurn` and woken through a prompt instead (see Delivery timing). |
| `context` | `false`       | `nextTurn`  | Waits for the next user prompt; does not wake or steer the agent.                                                                                       |
| `ignore`  | `false`       | `nextTurn`  | Suppressed for successful exits and external kills; emitted log matches wait for the next user prompt. Failures are promoted to `context`.              |

Every delivered message has `display: true` and is persisted when Pi adds it to
the conversation. A `nextTurn` message is not displayed or persisted until the
next user prompt.

## Lifecycle notifications

`NotificationService.handleProcessEnded` runs on every `process_ended` event
(deferred one microtask so the start tool can register the notify config
first). It classifies the end, resolves attention from the per-process config
or defaults, and either emits or suppresses.

### Classification

`classifyProcessEnd` (`extensions/processes/notifications/classify.ts`):

| `ProcessInfo.status` / `endReason`          | Kind      |
| ------------------------------------------- | --------- |
| `status === "killed"`                       | `killed`  |
| `success === true`                          | `success` |
| `endReason` ∈ `spawn_error`/`missing_pid`/`lost` | `crash` |
| `exitCode !== null && exitCode !== 0`       | `crash`   |
| otherwise                                   | `failure` |

`terminate_timeout` never reaches `process_ended`: `ProcessManager.kill` sets
`endTime` and transitions to `terminate_timeout` without emitting, and the
`close` handler bails on the `endTime` guard. The timeout is carried by the
tool result (`KillResult.reason: "timeout"`) instead.

### Attention resolution

`resolveAttention` picks the config field for the kind, falling back to
`DEFAULT_ATTENTION`:

| Kind      | Config field | Default   |
| --------- | ------------ | --------- |
| `success` | `onSuccess`  | `turn`    |
| `failure` | `onFailure`  | `turn`    |
| `crash`   | `onFailure`  | `turn`    |
| `killed`  | `onKilled`   | `context` |

### Forced display for crashes/failures

After resolving attention, the service forces a minimum of `context` for
`crash` and `failure`:

- If attention is `ignore` and the kind is `crash` or `failure`, attention is
  upgraded to `context` and the notification is emitted.
- If attention is `ignore` and the kind is `success` or `killed`, the
  notification is suppressed entirely (no emit).

This means `onFailure: "ignore"` cannot silence a failed process — failures
always notify, so it becomes a context message for the next user prompt.
`onSuccess: "ignore"` and `onKilled: "ignore"` suppress their notifications.

### Intentional stops (config bypass)

A stop is *intentional* when it goes through `killIntentionally`
(`extensions/processes/handlers/kill-process.ts`), which calls
`registry.markIntentionalStop(id)` before `manager.kill`. Three entry points
use it:

- The `process stop` tool.
- The `/ps:kill` command.
- The `/ps` overview panel `x` key (via `requestKill` →
  `CHANNELS.COMMAND_KILL`).

When `handleProcessEnded` sees an intentional stop, it **bypasses the
per-process config entirely** and emits a single `context` notification with
the classified kind. The agent is not woken, but it learns the process ended.
User `onKilled`/`onSuccess`/`onFailure` settings are ignored on this path.

If the kill fails (`not_found`/`error`) or the process is already dead, the
intentional-stop marker is consumed back and the normal path runs.

### End-state callstacks

Each block shows the call chain and the notification it produces. "Emit" means
a `CHANNELS.NOTIFICATION` payload with the shown attention; the delivery
listener then sends it as a Pi message.

#### Normal success

```
child process exits 0
  ProcessRuntimeController.child.on("close")          src/manager/process-runtime-controller.ts
    transition(managed, "exited")
      emit process_ended
        NotificationService.handleEvent               extensions/processes/notifications/service.ts
          queueMicrotask → handleProcessEnded
            classifyProcessEnd → "success"
            resolveAttention → config.onSuccess ?? "turn"
            emit kind=success attention=<onSuccess>
              delivery listener → sendProcessNotificationMessage(triggerTurn=<onSuccess>)
```

Default: a turn. `onSuccess: "context"` downgrades to a context message.
`onSuccess: "ignore"` suppresses.

#### Normal failure (non-zero exit)

```
child process exits non-zero
  ProcessRuntimeController child.on("close")
    transition(managed, "exited")
      emit process_ended
        handleProcessEnded
          classifyProcessEnd → "crash"          (exitCode !== 0)
          resolveAttention → config.onFailure ?? "turn"
          forced display: onFailure==="ignore" → upgraded to "context"
          emit kind=crash attention=<resolved or "context">
            delivery listener → sendProcessNotificationMessage
```

Default: a turn. `onFailure: "ignore"` becomes a context message (never fully
silent).

#### Spawn error / missing pid / lost

```
spawn error (or liveness tick detects lost/missing_pid)
  handleSpawnError / livenessTick
    transition(managed, "exited")
      emit process_ended
        handleProcessEnded
          classifyProcessEnd → "crash"
          resolveAttention → config.onFailure ?? "turn"
          forced display: ignore → "context"
          emit kind=crash attention=<resolved or "context">
```

Same as normal failure: defaults to turn, `ignore` forced to context.

#### External kill (signal from outside the manager)

```
external signal kills the process group
  child.on("close", code, signal)
    transition(managed, "killed")                signal branch
      emit process_ended
        handleProcessEnded
          isIntentionalStop? no (no marker)
          classifyProcessEnd → "killed"
          resolveAttention → config.onKilled ?? "context"
          (no forced display for killed)
          attention==="ignore" → suppressed; else emit kind=killed
            delivery listener → sendProcessNotificationMessage(triggerTurn=<onKilled>)
```

Default: a context message (no turn). `onKilled: "turn` promotes to a turn.
`onKilled: "ignore"` suppresses.

#### Intentional stop (config bypass)

```
/ps panel "x" | /ps:kill | process stop tool
  requestKill / executeStop
    COMMAND_KILL handler                         extensions/processes/handlers/commands.ts
      killIntentionally                          extensions/processes/handlers/kill-process.ts
        registry.markIntentionalStop(id)
        manager.kill(id, opts)
          transition(managed, "killed"|"exited")
            emit process_ended
              handleProcessEnded
                isIntentionalStop? yes
                  BYPASS config — emit kind=<classified> attention="context"
                    delivery listener → sendProcessNotificationMessage(triggerTurn=false)
```

Always a context message. Config is ignored. The agent is not woken.

#### Kill timeout (terminate_timeout)

```
manager.kill SIGTERM grace period expires, process still alive
  ProcessRuntimeController.kill                     src/manager/process-runtime-controller.ts
    endReason = "kill_timeout"; endTime = Date.now()
    transition(managed, "terminate_timeout")       (no process_ended emit — not exited/killed)
      returns KillResult { ok: false, reason: "timeout" }
  child.on("close") later → bails on endTime guard, no second process_ended
```

No notification. The timeout is reported through the tool/command result only.

## Log-watch notifications

`NotificationService.handleOutputChanged` runs on every
`process_output_changed` event. It syncs the compiled matcher set for the
process, evaluates matchers against the appended text, and emits one
`log_match` payload per match with the matcher's `on` attention.

```
process emits output
  ProcessOutput append
    emit process_output_changed { id, appendedText }
      NotificationService.handleOutputChanged
        registry.getWatchState(id) → null? return
        syncMatcherState(id, watchState)
        evaluateLogMatchers(matchers, appendedText, now)
          per matcher: skip if !repeat && fired; cooldown if repeat+fired
          per line: stream filter, plainTextForDisplay, lineMatcher
        for each match:
          emit kind=log_match attention=match.on
            delivery listener → rate-limit check → sendProcessNotificationMessage
```

Matcher behavior:

- `repeat: false` (default) fires once per process lifetime.
- `repeat: true` fires again after a 15s cooldown
  (`LOG_MATCH_COOLDOWN_MS`).
- Lines are normalized with `plainTextForDisplay` before matching, so CR
  progress lines and escape bytes do not fire watches.
- Lines longer than 10 000 chars are skipped.

Log-match `on: "ignore"` intentionally retains the match as context rather
than suppressing it. The delivery listener treats it like `context`, so it does
not wake or steer the agent and appears with the next user prompt. Use either
value when a match is useful later but requires no immediate response.

### Log-match rate limiting

The delivery listener caps live `log_match` deliveries at 20 per 60s window
(`MAX_LOG_MATCH_NOTIFICATIONS_PER_WINDOW`, `NOTIFICATION_WINDOW_MS`). Overflows
are counted and flushed as a single summary at window end:

```
log_match payload arrives
  delivery listener
    window expired or new? flush prior suppressed summary (kind=log_match_suppressed, attention=context)
    sentInWindow >= 20? suppressed++; return
    sentInWindow++; sendProcessNotificationMessage
  (window timer) flushSuppressedSummary
    emit kind=log_match_suppressed summary "Suppressed N log-match notifications..."
```

The summary is always `context`.

## Summary matrix

| End state                | Kind     | Default attention | Config field | `ignore` effect        | Bypassed by intentional stop? |
| ------------------------ | -------- | ----------------- | ------------ | ---------------------- | ----------------------------- |
| exit 0                   | success  | turn              | `onSuccess`  | suppressed             | yes → context                 |
| exit non-zero            | crash    | turn              | `onFailure`  | forced to context      | yes → context                 |
| spawn_error/missing/lost | crash    | turn              | `onFailure`  | forced to context      | yes → context                 |
| external signal          | killed   | context           | `onKilled`   | suppressed             | yes → context                 |
| intentional stop         | (classified) | context       | —            | —                      | (this is the bypass)          |
| kill timeout             | —        | —                 | —            | —                      | no emit (tool result only)    |
| log match                | log_match | turn             | matcher `on` | delivered as context   | n/a                           |
| log-match overflow       | log_match_suppressed | context | —    | —                      | n/a                           |

## References

- `extensions/processes/notifications/service.ts` — event handling, attention
  resolution, intentional-stop bypass, log-match emission.
- `extensions/processes/notifications/classify.ts` — end classification.
- `extensions/processes/notifications/registry.ts` — per-process config and
  intentional-stop markers.
- `extensions/processes/handlers/kill-process.ts` — intentional stop marking.
- `extensions/processes/handlers/notifications.ts` — delivery listener and
  rate limiting.
- `extensions/processes/notification-sender.ts` — attention → Pi send options.
- `extensions/processes/tools/notify.ts` — config normalization and defaults.
- `src/manager/process-runtime-controller.ts` — `process_ended` emission,
  `terminate_timeout` non-emit, `close`/`error`/liveness paths.
