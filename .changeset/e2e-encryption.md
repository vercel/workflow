---
"@workflow/cli": patch
"@workflow/core": patch
"@workflow/web-shared": patch
"@workflow/world-vercel": patch
"@workflow/world": patch
"@workflow/world-testing": patch
---

Add end-to-end encryption for workflow user data

This implements AES-256-GCM encryption with per-run key derivation via HKDF-SHA256 for workflow user data.

Key changes:
- Add encryption module with `createEncryptor()` and `createEncryptorFromEnv()` functions
- Add `Encryptor`, `EncryptionContext`, `KeyMaterial` interfaces to `@workflow/world`
- Make all (de)hydrate serialization functions async and accept encryptor parameter
- Update `runWorkflow()` to take world as 4th parameter
- Update `WorkflowOrchestratorContext` to include `runId` and `world`
