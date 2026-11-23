---
'@workflow/core': patch
---

Retry transient World errors (timeouts, 5xx, 429) up to 10 times in a row while `run.returnValue` waits for a run, instead of rejecting on the first one.
