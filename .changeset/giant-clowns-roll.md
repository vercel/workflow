---
'@workflow/core': patch
---

Queue the workflow continuation when a step completion retry reports an already completed step, preventing runs from remaining stuck in the running state.
