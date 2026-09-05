---
'@workflow/core': major
'workflow': major
'@workflow/world-testing': patch
---

**Breaking:** `hook.metadata` is now a lazy getter that returns a Promise, like `run.returnValue` — `await hook.metadata` to read it, and the accessor is non-enumerable, so it is absent from `{ ...hook }` and `JSON.stringify(hook)`. That makes `getHookByToken()` a single read (the run fetch and `run-key` round trip hydration needs are only paid by callers that access metadata, so hook resumption stops paying them), and `resumeHook()`'s returned hook now hydrates metadata instead of exposing raw serialized bytes.
