---
'@workflow/world': minor
'@workflow/world-local': minor
'@workflow/world-postgres': minor
'@workflow/world-vercel': minor
---

Add an optional, experimental `experimental_snapshots` storage interface for the QuickJS engine's VM-memory snapshotting (`save`/`load`/`delete` plus `SnapshotMetadata`, and `encodeSnapshotEnvelope`/`decodeSnapshotEnvelope` helpers that pack metadata and bytes into one atomically storable blob). World implementations don't need to provide it: without it the runtime always does a full event replay. Implemented in world-local (one envelope file per run under `snapshots/`), world-postgres (new `workflow_snapshots` table, migration `0025_add_snapshots_table`, applied by the package's `bootstrap` command), and world-vercel (backend snapshot endpoints; delete is idempotent). Inert until the runtime opts in.
