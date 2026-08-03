---
"@workflow/world-local": patch
---

Fix race in `events.create()` where concurrent `step_created` / `wait_created` writes with the same `correlationId` would both succeed instead of one losing with `EntityConflictError`.
