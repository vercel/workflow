---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
---

Materialize waits as entities to prevent duplicate wait_completed events

- `@workflow/core`: Handle 409 conflict gracefully when creating wait_completed events, preventing crashes when multiple concurrent invocations race to complete the same wait
- `@workflow/world`: Add `Wait` type, `WaitSchema`, and `WaitStatusSchema` exports; add optional `wait` field to `EventResult`
- `@workflow/world-local`: Materialize wait entities on wait_created/wait_completed with duplicate detection; clean up waits on terminal run states
- `@workflow/world-postgres`: Add `workflow_waits` table with `wait_status` enum; materialize wait entities with conditional writes for duplicate prevention; clean up waits on terminal run states
