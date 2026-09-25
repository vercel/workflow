---
"@workflow/core": patch
---

Keep a retained owner's workflow session when a wake brings no new events, such as a step-recovery timer that fires after its steps finished. Previously the empty resume was treated as an unusable session and failed the run.
