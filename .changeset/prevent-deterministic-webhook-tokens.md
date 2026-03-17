---
'@workflow/core': minor
---

**BREAKING CHANGE**: `createWebhook()` no longer accepts a `token` option. Webhook tokens are always randomly generated to prevent unauthorized access to the public webhook endpoint. Use `createHook()` with `resumeHook()` for deterministic server-side token patterns.
