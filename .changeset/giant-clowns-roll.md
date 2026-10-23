---
'@workflow/core': patch
---

Queue the workflow continuation when a step completion or failure retry reports an already finished step, preventing runs from remaining stuck in the running state.
