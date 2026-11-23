---
"@workflow/world": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/world-vercel": minor
---

New runs on the Vercel, Local and Postgres Worlds use spec 10 (the single orchestrator, with `experimental_rateLimit()`) by default; `WORKFLOW_SPEC_VERSION=8` opts out. Third-party Worlds create spec 9 runs if they implement only the in-band fence, and spec 8 runs otherwise.
