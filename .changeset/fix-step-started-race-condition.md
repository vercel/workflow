---
'@workflow/world-postgres': patch
'@workflow/world-local': patch
---

Add atomic terminal-state guards to all entity update operations across both postgres and local worlds to match the Vercel world's DynamoDB conditional expressions.

**Postgres world**: Add conditional WHERE clauses to prevent TOCTOU races where concurrent requests bypass pre-validation and corrupt the event log.

**Local world**: Use `writeExclusive` lock files to atomically prevent concurrent terminal state transitions for steps and waits. Add `cancelled` to `isStepTerminal`.
