---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/errors": minor
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/builders": patch
"@workflow/nitro": patch
"@workflow/web-shared": patch
"workflow": minor
---

Runs use a single orchestrator: steps retry in place on one queue message and `maxRetries: 0` steps run at most once. Turbo, optimistic inline start, inline ownership, resilient dispatch and precondition settings are removed.
