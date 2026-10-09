---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/world-vercel": minor
"@workflow/world-testing": patch
---

Every World must implement the in-band writer fence and declare `capabilities.inBandFence`; the runtime refuses a World that does not.
