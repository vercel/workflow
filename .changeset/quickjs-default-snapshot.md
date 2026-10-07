---
"@workflow/core": patch
---

Enable VM-memory snapshotting by default for the QuickJS engine, with a threshold of 1000 events. Set `WORKFLOW_SNAPSHOT_THRESHOLD=0` to opt out. Runs without an encryption key (for example on world-local and world-postgres) are still not snapshotted unless `WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED=1` is set.
