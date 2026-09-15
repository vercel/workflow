---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Pre-claim inline steps inside the suspension batch, so a fan-out's inline step bodies start off the batch commit with no per-step claim request
