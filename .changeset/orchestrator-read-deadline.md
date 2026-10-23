---
'@workflow/core': patch
'@workflow/world-vercel': patch
'@workflow/world': patch
---

Retry an orchestrator event log read that never returns, instead of holding the run until the invocation ends.
