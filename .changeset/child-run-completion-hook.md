---
'@workflow/core': minor
'@workflow/world-postgres': patch
---

Awaiting `run.returnValue` of a child run from the workflow that started it now suspends on one system hook per parent, which each child resumes when it finishes, instead of polling inside a step.
