---
'@workflow/world-postgres': patch
---

Queue deliveries no longer inherit `fetch`'s 300s headers/body deadlines, which redelivered healthy long-running inline work while it was still executing. Deadlines can be set with `WORKFLOW_POSTGRES_HEADERS_TIMEOUT_MS` and `WORKFLOW_POSTGRES_BODY_TIMEOUT_MS`.
