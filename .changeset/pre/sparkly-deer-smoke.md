---
"@workflow/world": minor
"@workflow/core": minor
"@workflow/errors": minor
"@workflow/world-postgres": minor
"@workflow/world-local": patch
"@workflow/world-vercel": patch
---

Add an optional `invoke` method and capability to the World interface. It routes a payload to the runner handling the specified `runId` and returns a promise for its response. In world-postgres, this uses a regular queue roundtrip with a run-scoped queue. The runtime uses `invoke` when available, initially to resume hooks.
