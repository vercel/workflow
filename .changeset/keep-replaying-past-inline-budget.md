---
"@workflow/core": patch
---

Keep replaying past the inline budget while an inline step is still running, so an event that arrives then (a hook resume that aborts the step, for example) reaches the workflow instead of waiting for the step to end. The run still hands off to the next delivery at the first pass with no inline step in flight.
