---
"@workflow/world-postgres": patch
---

Fix forced hook token claims racing in Postgres World: a forced `createHook()` that lost the race to another forced claim no longer ends in a plain `hook_conflict`. Add regression tests for concurrent claims of one token from many runs.
