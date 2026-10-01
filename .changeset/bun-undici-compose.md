---
'@workflow/world-vercel': patch
---

Fix `createQueueDispatcher()` and `createEventsDispatcher()` crashing under Bun with `compose is not a function`. Bun resolves `undici` to its built-in module, whose dispatchers can't compose interceptors and are ignored by Bun's `fetch`, so the plain dispatcher is used instead.
