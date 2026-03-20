---
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-vercel": patch
"@workflow/world-postgres": patch
"@workflow/core": patch
"@workflow/cli": patch
"@workflow/web": patch
---

**BREAKING CHANGE**: Restructure stream methods on World interface to use `world.streams.*` namespace with `runId` as the first parameter. `writeToStream(name, runId, chunk)` → `streams.write(runId, name, chunk)`, `writeToStreamMulti` → `streams.writeMulti`, `closeStream` → `streams.close`, `readFromStream` → `streams.get(runId, name, startIndex?)`, `listStreamsByRunId` → `streams.list(runId)`.
