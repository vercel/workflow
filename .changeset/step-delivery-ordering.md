---
'@workflow/core': patch
---

Deliver step results, wait completions and hook payloads in strict event-log order relative to one another, preventing replay divergence (`CORRUPTED_EVENT_LOG`) when a step completion is adjacent in the log to a `wait_completed` or `hook_received` that a concurrent branch is awaiting.
