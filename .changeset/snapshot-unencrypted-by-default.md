---
'@workflow/core': minor
---

Snapshot QuickJS runs that have no encryption key without an opt-in. The runtime no longer reads `WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED`: on world-local, world-postgres and any other World that doesn't implement `getEncryptionKeyForRun()`, QuickJS runs now snapshot by default (threshold 1000), stored in plaintext like the event log and payloads those Worlds already keep. Runs with an encryption key are unchanged: their snapshots are encrypted, and a plaintext snapshot is still rejected on restore. Set `WORKFLOW_SNAPSHOT_THRESHOLD=0` to keep full replay.
