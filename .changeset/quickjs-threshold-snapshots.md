---
'@workflow/core': patch
'@workflow/world': patch
'workflow': patch
---

Add experimental threshold-based VM-memory snapshotting to the QuickJS engine via `WORKFLOW_SNAPSHOT_THRESHOLD` (or per-run `executionContext.snapshotThreshold`). Once the configured number of events has been processed since the last snapshot, suspensions persist a compressed, encrypted VM snapshot through `world.experimental_snapshots`; resumptions restore the VM and replay only the delta events, falling back to full replay whenever a snapshot is missing or can't be verified. Runs without an encryption key are only snapshotted with `WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED=1`. `0` (default) disables snapshotting. `@workflow/world` gains the snapshot metadata fields and `SNAPSHOT_FORMAT_VERSION`.
