---
"@workflow/core": patch
"@workflow/cli": patch
---

**BREAKING CHANGE**: Make `getWorld` and `createWorld` asynchronous to support ESM dynamic imports for custom world modules. All callers must now `await getWorld()`.
