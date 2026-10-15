---
"@workflow/world-postgres": patch
---

Write a step's `step_completed` or `step_failed` row update and its event in one transaction, as `step_started` already does. A process that died between the two used to leave a terminal step with no terminal event, so the replayed `step_started` was refused as terminal and the run never advanced.
