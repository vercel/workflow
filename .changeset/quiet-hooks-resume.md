---
"@workflow/world-postgres": patch
---

Allow same-run queue wakes to reach a workflow while an inline step is pending, so hook-driven cancellation and steering do not wait for the step to finish.
