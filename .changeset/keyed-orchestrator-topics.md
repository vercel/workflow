---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
"@workflow/world-local": patch
"@workflow/world-postgres": patch
---

On Vercel, spec 9 runs keep one orchestrator invocation per run with a queue concurrency key on the existing flow topic; spec 8 runs keep their previous queue behavior.
