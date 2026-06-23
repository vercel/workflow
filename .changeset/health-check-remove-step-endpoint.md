---
'@workflow/core': patch
'workflow': patch
'@workflow/cli': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/web': patch
---

Remove unused `/v1/step` queue route plumbing and `step` health-check endpoint and message redundant message dispatch
