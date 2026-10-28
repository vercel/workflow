---
'@workflow/core': patch
'workflow': patch
'@workflow/errors': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
---

Trace `start({ hook })` outcomes: rejection reasons on `WorkflowWorldError.reason`, an outcome on every exit of the start span and on a queued copy's invocation span, a reason for every holder wake, a reserved token's lookup on the `hook.resume` span, and debug logs of local and Postgres admission decisions.
