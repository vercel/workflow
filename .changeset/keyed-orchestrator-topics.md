---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
"@workflow/builders": minor
"@workflow/next": patch
"@workflow/nitro": patch
"@workflow/sveltekit": patch
---

On Vercel, spec 9 runs keep one orchestrator invocation per run with a queue concurrency key instead of per-run `maxConcurrency` topics; flow routes now get a second queue trigger.
