---
'@workflow/core': patch
---

Remove redundant `hc_` prefix from health check correlationId that caused doubled `hc_hc_` in the derived runId and stream name.
