---
"@workflow/nest": minor
---

`WorkflowModule` hands the built flow route to the World in `onModuleInit`, before `manageWorldLifecycle` starts it, for a World that delivers in process (`WORKFLOW_TARGET_WORLD` names the Postgres World or a World of the app's own that declares `queueAuthMode: 'deny'`, or the lifecycle is managed); a registration failure on such a World fails startup. The Local and Vercel Worlds are not built at boot.
