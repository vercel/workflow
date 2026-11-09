---
"@workflow/nest": minor
---

`WorkflowModule` hands the built flow route to the World in `onModuleInit`, before `manageWorldLifecycle` starts it; on a World that delivers in process (the Postgres World) a registration failure is fatal, on any other World the registration does nothing.
