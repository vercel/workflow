---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
'workflow': patch
---

Add `experimental_setAttributes()` workflow-level helper for attaching string key/value metadata to a workflow run, surfaced as `run.attributes`
