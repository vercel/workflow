---
"@workflow/world-postgres": patch
---

Fix race in `events.create()` where concurrent `step_created` / `hook_created` / `wait_created` writes with the same `correlationId` would persist duplicate event rows. Adds a unique partial index and surfaces the violation as `EntityConflictError`.
