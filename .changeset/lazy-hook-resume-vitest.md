---
'@workflow/vitest': patch
---

`waitForHook()` accepts `notHookId` to skip a hook the caller already resumed, whose `hook_received` may not be written yet.
