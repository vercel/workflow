---
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Derive inline-execution duration limits from `World.getRuntimeDeadline()` (implemented on Vercel World via `@vercel/functions`).
