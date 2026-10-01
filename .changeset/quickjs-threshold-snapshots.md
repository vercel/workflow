---
'@workflow/core': patch
'@workflow/world': patch
'workflow': patch
---

Add experimental threshold-based VM-memory snapshotting to the QuickJS engine via `WORKFLOW_SNAPSHOT_THRESHOLD` (or per-run `executionContext.snapshotThreshold`). Once the configured number of events has been processed since the last snapshot, suspensions persist a compressed, encrypted VM snapshot, which is later used for resumption. Runs without an encryption key are only snapshotted with `WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED=1`
