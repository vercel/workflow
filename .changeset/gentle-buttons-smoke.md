---
'@workflow/core': patch
---

Fix replay-engine determinism defects that could surface as `CORRUPTED_EVENT_LOG`: delivery barriers were retired while their own delivery was still in flight (by a global idle tick, or by an abandon deadline that ran through the payload's own hydration), an abandoned barrier could never retire under continuous unrelated delivery traffic, and a barrier stopped being visible to the registry one statement before the branch it woke had run. Workflow suspensions now wait on delivery progress rather than a fixed number of poll rounds, so a wide batch of deliveries is never preempted part-way through, and no longer fire while a committed delivery is waiting out an unclaimed hook payload's abandon deadline. Both deadlines are overridable via `WORKFLOW_BARRIER_ABANDON_DEADLINE_TICKS` and `WORKFLOW_IDLE_POLL_DEADLINE_ROUNDS`.
