---
'@workflow/web-shared': patch
---

Mark the second of two attribute writes under one id as read past, matching what the runtime does with it, and stop treating a run's step-written attribute events as repeats of each other.
