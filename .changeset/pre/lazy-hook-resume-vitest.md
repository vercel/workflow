---
'@workflow/vitest': patch
---

`waitForHook()` accepts `notHookId` to exclude a previously observed hook when a workflow creates several hooks with the same token.
