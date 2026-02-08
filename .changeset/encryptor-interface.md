---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/cli": patch
"@workflow/web": patch
"@workflow/world-testing": patch
---

Add encryption key interface and thread through serialization layer

Adds `World.getEncryptionKeyForRun()` to `@workflow/world` — the World retrieves and derives the per-run AES-256 encryption key. The 8 dehydrate/hydrate serialization functions now accept an optional `key: Uint8Array | undefined` parameter for future encryption support. Restructures `resumeHook` to resolve the encryption key once and reuse for both metadata decryption and payload encryption.

**Breaking change (internal API):** The dehydrate/hydrate function parameter order has changed. For example, `dehydrateWorkflowArguments(value, ops, runId, ...)` is now `dehydrateWorkflowArguments(value, runId, key, ops, ...)`. The `runId` and `key` parameters are now grouped together as the 2nd and 3rd arguments across all 8 functions. These are internal APIs not intended for external consumption.
