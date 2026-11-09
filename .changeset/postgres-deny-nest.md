---
"@workflow/nest": minor
---

`WorkflowModule` hands the built flow route to the World in `onModuleInit`, before `manageWorldLifecycle` starts it, when `WORKFLOW_TARGET_WORLD` is `@workflow/world-postgres` or the lifecycle is managed; a registration failure on a World that delivers in process fails startup. Other Worlds are not built at boot.
