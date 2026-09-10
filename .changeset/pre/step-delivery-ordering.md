---
'@workflow/core': patch
---

Deliver step results, wait completions, hook payloads and aborts in strict event-log order relative to one another, preventing replay divergence (`CORRUPTED_EVENT_LOG`) when a step completion is adjacent in the log to a `wait_completed`, `hook_received` or abort that a concurrent branch is awaiting.
