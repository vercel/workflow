---
'@workflow/core': patch
---

Retry transient world response-body parse failures (e.g. a truncated `events.list` response during replay) by propagating them to the queue instead of failing the run. Genuine schema-validation contract errors remain fatal.
