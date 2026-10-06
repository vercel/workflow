---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/errors": minor
"@workflow/web-shared": patch
"workflow": minor
---

New runs use one orchestrator per run: steps retry in place on one queue message, `maxRetries: 0` steps run at most once, and turbo, optimistic inline start, inline ownership, resilient dispatch and precondition settings are removed.
