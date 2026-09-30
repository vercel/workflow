---
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
---

Add an _optional_, experimental `experimental_snapshots` storage interface for the QuickJS engine's VM-memory snapshotting (`save`/`load`/`delete` plus `SnapshotMetadata`, and `encodeSnapshotEnvelope`/`decodeSnapshotEnvelope`.
