---
"@workflow/world-postgres": patch
---

Write `run_started`, `run_completed`, `run_failed`, `run_cancelled`, `attr_set`, `step_retrying`, `wait_created` and `wait_completed` in one transaction with the entity change they record. A process that died between the two used to leave an entity in a state its event log did not explain; a completed wait with no `wait_completed` made the run retry the wait forever. A wait left in that state by an earlier version now gets its missing event on the next attempt.
