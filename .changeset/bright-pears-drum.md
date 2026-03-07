---
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-vercel": patch
"@workflow/world-postgres": patch
"@workflow/core": patch
"@workflow/cli": patch
"@workflow/web": patch
---

Restructure stream methods on World interface to use `world.streams.*` namespace. `writeToStream` → `streams.write`, `writeToStreamMulti` → `streams.writeMulti`, `closeStream` → `streams.close`, `readFromStream` → `streams.get`, `listStreamsByRunId` → `streams.list(runId)`.
