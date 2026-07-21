---
'@workflow/swc-plugin': patch
---

Honor `maxRetries` set on a step defined inside a workflow body; the assignment was previously dropped, silently reverting the step to the default retry count.
