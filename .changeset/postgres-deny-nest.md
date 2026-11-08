---
"@workflow/nest": minor
---

`onModuleInit` hands the built flow route to the World before `manageWorldLifecycle` starts it, for a World that delivers in process (the Postgres World); not on Vercel.
