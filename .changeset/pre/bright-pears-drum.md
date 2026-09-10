---
"@workflow/world": major
"@workflow/world-local": major
"@workflow/world-vercel": major
"@workflow/world-postgres": major
"@workflow/core": major
"@workflow/cli": major
"@workflow/web": major
---

**BREAKING CHANGE**: Restructure stream methods on World interface to use `world.streams.*` namespace with `runId` as the first parameter. `writeToStream(name, runId, chunk)` → `streams.write(runId, name, chunk)`, `writeToStreamMulti` → `streams.writeMulti`, `closeStream` → `streams.close`, `readFromStream` → `streams.get(runId, name, startIndex?)`, `listStreamsByRunId` → `streams.list(runId)`.
