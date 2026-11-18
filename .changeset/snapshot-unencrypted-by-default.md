---
'@workflow/core': minor
---

Snapshot QuickJS runs that have no encryption key without an opt-in. Runs with an encryption key are unchanged: their snapshots are encrypted, and a plaintext snapshot is still rejected on restore.
