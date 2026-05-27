---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
'workflow': patch
---

Add `experimental_setAttributes()` for attaching plaintext string key/value metadata to a workflow run. Callable from a workflow body; the call is dispatched as a step so the mutation is recorded on the event log. `run.attributes` always reads as a record across worlds (defaults to `{}` after schema parsing).
