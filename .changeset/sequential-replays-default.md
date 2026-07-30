---
'@workflow/world-vercel': minor
'@workflow/builders': minor
'@workflow/nitro': minor
'@workflow/world': minor
'@workflow/core': minor
'workflow': minor
---

Serialize a run's orchestrator invocations by default on Vercel, and dispatch steps to the queue instead of running them inline when a run has a pending `sleep()` or hook so its wake-up is never stuck behind a step.
