---
'@workflow/core': patch
---

`hook.dispose()` no longer stops delivery on the spot. The release becomes durable at the run's next suspension, and `resumeHook()` is accepted until then, so a payload accepted in between sits in the event log ahead of `hook_disposed`; it is now delivered to awaiters and `for await` consumers, whose iteration ends once the disposal event is observed. Previously such a payload was acknowledged and then lost on the retained-VM path (and made the workflow's view replay-inconsistent). Also adds e2e coverage for background hook subscribers, merged hook inboxes (including a hook added mid-run), the drain-then-wait session loop, and the dispose-and-hand-off ending.
