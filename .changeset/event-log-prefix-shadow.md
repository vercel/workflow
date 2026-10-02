---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Add an opt-in, metadata-only event-log prefix shadow (`WORKFLOW_EVENT_LOG_PREFIX_SHADOW=1`, off by default). On each `run_started` or lazy `hook_received` preload it measures whether the dense log prefix an earlier invocation of the run held on this process would have been reusable, and how many preload bytes and how much stream time a tail-only preload would have saved. Results go to the `workflow.replay.load` span and to `workflow.replay.prefix_shadow.*` metrics. It holds no events or payloads and changes nothing a run does. To support it, the `replayEventObserver` callback now receives each event's wire frame size, and world-vercel declares this with the new `replayEventFrameBytes` World capability.
