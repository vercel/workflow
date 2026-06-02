---
'@workflow/core': minor
'workflow': minor
---

Add a process-wide LRU cache for workflow event logs so warm function instances delta-fetch only new events on resume instead of reloading from event 0 on every invocation. Disable with `WORKFLOW_DISABLE_EVENT_CACHE=1`.
