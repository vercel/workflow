---
"@workflow/core": patch
---

Fix a step that could be created and never run when two executions of it met in one process and the first one's claim lost.
