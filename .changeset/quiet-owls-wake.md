---
"@aliou/pi-processes": patch
---

Wake an idle agent for `turn` notifications through a prompt so `before_agent_start` still runs

An idle host started the woken turn directly (`sendMessage` with `triggerTurn: true`), which skips `before_agent_start`. The turn then lacked every system-prompt addition other extensions make there, and providers that depend on it (for example pi-claude-bridge) rejected it. `turn` notifications are now routed by host state: steered during an active run as before, stored as `nextTurn` plus one `sendUserMessage` wake when idle, and held until the host reports a boundary while it is busy without a run (compaction, branch summarization). Notifications in the same pass share one wake. A notification that arrives after a prompt has drained the pending `nextTurn` messages but before its run starts is held and steered into that run, so it is never stranded. If no usable extension context exists, the original call is used.

The end of a run is detected with `agent_settled` (Pi 0.80.4+); on older hosts every `turn` notification is steered as before. Notifications held during compaction or branch summarization are dropped when the session changes. A stored notification whose wake was suppressed by a prompt that never started a run is woken once that start window expires.
