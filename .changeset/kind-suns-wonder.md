---
"@workflow/world-postgres": patch
"@workflow/sveltekit": patch
"@workflow/builders": patch
---

- export stepEntrypoint and workflowEntrypoint from build
- add abstract queue driver to world postgres
- add execution strategy to world postgres
- add Graphile Worker as alternative queue driver (set `WORKFLOW_QUEUE_DRIVER=graphile` to enable)
