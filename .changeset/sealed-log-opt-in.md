---
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/core': patch
---

New runs are no longer created with the sealed-log event identity (specVersion 7) by default; set `WORKFLOW_SEALED_LOG=1` to opt in. Every runtime still reads sealed logs, and a run's version is fixed at creation, so runs already created at specVersion 7 keep working.
