---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-vercel': minor
'@workflow/world-local': minor
'@workflow/world-postgres': minor
'@workflow/web-shared': minor
'@workflow/cli': minor
'workflow': minor
---

Add experimental dynamic workflows: `start()` accepts workflow source as a string, compiled and stored encrypted with the run and replayed from there. Steps are exposed to the source through an explicit `dynamic.steps` allowlist.
