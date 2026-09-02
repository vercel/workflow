---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'workflow': patch
---

Add experimental dynamic workflows: `start()` now accepts workflow source as a string, for orchestration whose shape is only known after deployment (workflow-builder UIs, customer-defined automations, AI-generated plans). The source is compiled to workflow VM code, stored with the run — compressed and encrypted with the run's key, behind a blob ref on worlds that have one — and replayed from there, so a run always executes the exact code it started on. Steps must already be registered in the deployment and are exposed to the source through an explicit `dynamic.steps` allowlist.
