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

Add experimental dynamic workflows: `start()` accepts workflow source as a string, compiles and stores it with the run through the run-payload serialization pipeline, and replays from that stored code. Steps are exposed to the source through an explicit `dynamic.steps` allowlist.
