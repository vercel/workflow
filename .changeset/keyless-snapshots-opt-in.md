---
'@workflow/core': patch
---

Require `WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED=1` again before QuickJS stores VM snapshots for runs without an encryption key, since a snapshot holds the handler's environment variables.
