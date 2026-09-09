---
'@workflow/core': major
'workflow': major
'@workflow/world-testing': patch
---

**Breaking:** `hook.metadata` on hooks returned by `getHookByToken()` and `resumeHook()` is now a lazy getter that returns a Promise, like `run.returnValue`, and needs to be awaited. Looking a hook up by token no longer pays for hydrating metadata that is never read.
