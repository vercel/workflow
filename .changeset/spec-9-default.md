---
"@workflow/world": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/world-vercel": minor
---

Create spec 9 (single-orchestrator) runs by default on Worlds that declare the in-band fence, which includes the Vercel, Local and Postgres Worlds. `mintedSpecVersion(env, { inBandFence: true })` now returns 9 when `WORKFLOW_SPEC_VERSION` is unset, and `SPEC_VERSION_DEFAULT_MINTED_FENCED` names that default. A World without the fence keeps creating spec 8 runs. Set `WORKFLOW_SPEC_VERSION=8` to keep new runs on spec 8, for example until every deployment and process that shares a World runs this release. Runs already created keep their spec version.
