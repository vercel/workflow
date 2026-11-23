---
"@workflow/world": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/world-vercel": minor
---

New runs on the Vercel, Local and Postgres Worlds now use a new execution engine that supports speculative execution, and vastly reduces engine overhead. `WORKFLOW_SPEC_VERSION=8` opts out. Runs on third-party worlds use the old engine (spec 8) unless they implement the prerequisites.
