---
'@workflow/core': patch
---

Write a suspension's hook events alongside its step, wait, and attribute events instead of ahead of them, so a step no longer waits for the hooks created with it to be registered before it can start. The batched fan-out now also engages when the suspension creates or disposes hooks, and a lone inline step created beside a hook has its claim folded into that batch so it commits concurrently with the hook write. A workflow that needs a hook registered before a step runs (for example, a step that hands the token to something that resumes it at once) awaits `hook.getConflict()` first.
