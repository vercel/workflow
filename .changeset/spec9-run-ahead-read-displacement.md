---
'@workflow/core': patch
---

Close a remaining spec 9 run-ahead gap: an incremental read of the event log could bring a committed event to a slot the orchestrator held another event's speculative copy at, drop it, and let a pass run before the log was repaired. A read now follows the same rule as the live feed and a write's answer, and the repair runs before the next pass.
