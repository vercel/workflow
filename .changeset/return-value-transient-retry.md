---
'@workflow/core': patch
---

Retry transient World errors (timeouts, 5xx, 429) while `run.returnValue` waits for a run, instead of rejecting on the first one.
