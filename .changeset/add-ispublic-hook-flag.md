---
"@workflow/core": patch
"workflow": patch
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
---

Prevent hooks from being resumed via the public webhook endpoint by default. Add `isWebhook` option to `createHook()` to opt-in to public resumption. `createWebhook()` always sets `isWebhook: true`.
