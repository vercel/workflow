---
'@workflow/world-postgres': patch
---

Deliver queue messages without implicit HTTP headers or body deadlines so healthy long-running inline work is not redelivered, while preserving shutdown cancellation.
