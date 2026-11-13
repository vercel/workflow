---
"@workflow/core": major
"@workflow/errors": minor
"@workflow/world": minor
"@workflow/vitest": patch
---

**Breaking:** hooks now expire after 30 days by default. `createHook()`, `createWebhook()` and `defineHook().create()` accept a `ttl` (a duration string, milliseconds or a `Date`). When it passes, the hook is disposed, the run is woken, and the hook's awaiters reject with the new `HookExpiredError`. Pass `ttl: Infinity` to keep a hook open indefinitely.
