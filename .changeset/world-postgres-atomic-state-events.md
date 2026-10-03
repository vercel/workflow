---
'@workflow/world-postgres': patch
---

Commit `run_completed`, `run_failed`, `run_cancelled`, `step_completed`, `step_failed`, `step_retrying` and `wait_completed` in one transaction with their entity update, and announce a terminal run only after that commit (#3081).
