---
'@workflow/core': minor
'workflow': minor
---

Add threshold-based VM-memory snapshotting to the QuickJS engine via `WORKFLOW_SNAPSHOT_THRESHOLD` (or per-run `executionContext.snapshotThreshold`). Once the configured number of events has been processed since the last snapshot, suspensions persist a compressed (and encrypted, when configured) VM snapshot through `world.snapshots`; resumptions restore the VM and replay only the delta events, with automatic fallback to full replay on any load/restore failure. `0` (default) disables snapshotting.
