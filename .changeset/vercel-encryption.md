---
"@workflow/world-vercel": patch
"@workflow/core": patch
---

Add AES-256-GCM encryption to core and HKDF key derivation to world-vercel

Adds browser-compatible `encrypt()`/`decrypt()` functions to `@workflow/core/encryption` using the Web Crypto API (AES-256-GCM). Adds `deriveRunKey()` and `fetchDeploymentKey()` to `@workflow/world-vercel` for HKDF-SHA256 per-run key derivation and cross-deployment key retrieval.

Implements `World.getEncryptionKeyForRun()` in `createVercelWorld()` — accepts either a `WorkflowRun` or a `runId` string, derives a per-run AES-256 key using HKDF with the deployment key and project ID, and returns raw key bytes for use with core's encrypt/decrypt functions.
