---
"@workflow/world": minor
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/errors": patch
---

Add backwards compatibility for runs created with different spec versions

- Add `RunNotSupportedError` for runs requiring newer world versions
- Add semver-based version comparison utilities
- Legacy runs (< 4.1): route to legacy handlers
- `run_cancelled`: skip event storage, directly update run
- `wait_completed`: store event only (no entity mutation)
- Unknown legacy events: throw error
