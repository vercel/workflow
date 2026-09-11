---
'@workflow/world': minor
'@workflow/world-vercel': patch
---

Add an optional `capabilities?: WorldCapabilities` field to the World interface so implementations can declare backend feature support (`preconditionGuard`, `maxConcurrency`) instead of the runtime inferring it from environment variables; the Vercel World declares both.
