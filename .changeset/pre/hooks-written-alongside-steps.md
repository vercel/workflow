---
'@workflow/core': patch
---

Parallelize a suspension's hook event writes alongside its step, wait, and attribute events, so a step no longer waits for the hooks created with it to be registered before it can start
