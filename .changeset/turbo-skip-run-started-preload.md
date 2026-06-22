---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Turbo mode now tells world-vercel to skip the run_started event-log preload it never reads, trimming the run_started request the first step start waits behind.
