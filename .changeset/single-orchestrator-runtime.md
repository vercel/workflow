---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/errors": patch
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/world-testing": patch
"@workflow/vitest": patch
---

Add opt-in spec 9 runs, driven by a single orchestrator per run: set `WORKFLOW_SPEC_VERSION=9`. New runs stay on spec 8 by default.

- Without the setting, new runs are spec 8 and behave as before.
- To opt in, first upgrade every deployment and process that calls `start()` or shares the World to this release, then set `WORKFLOW_SPEC_VERSION=9` on all of them. An older release fails writes to spec 9 runs (reads still work, nothing is corrupted), so do not roll back below this release while spec 9 runs are in flight.
- Custom Worlds: `mintedSpecVersion()` keeps creating spec 8 runs. A World that implements the in-band writer fence declares `capabilities.inBandFence` and passes `{ inBandFence: true }` to create spec 9 runs.
