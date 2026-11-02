---
"@workflow/world-postgres": patch
---

Retire a job after the runtime's marked queue auth 401, logging one rate-limited line, instead of letting Graphile retry it for days; a bare 401 is still retried.
