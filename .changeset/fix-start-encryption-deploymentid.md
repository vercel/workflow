---
"@workflow/core": patch
---

Fix `start()` not encrypting initial workflow input in external contexts (e2e tests, CLI). The resolved `deploymentId` was not being passed to `getEncryptionKeyForRun`, causing it to silently skip encryption when `deploymentId` was inferred from the environment rather than explicitly provided in options.
