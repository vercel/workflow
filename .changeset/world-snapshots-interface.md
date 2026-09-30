---
'@workflow/world': minor
'@workflow/world-local': minor
'@workflow/world-postgres': minor
'@workflow/world-vercel': minor
---

Add an OPTIONAL `snapshots` storage interface (`save`/`load`/`delete` + `SnapshotMetadata`, plus `encodeSnapshotEnvelope`/`decodeSnapshotEnvelope` helpers that pack metadata and bytes into one atomically-storable blob) for VM-memory snapshotting, with implementations in world-local (single envelope file per run), world-postgres (`workflow_snapshots` table storing the envelope), and world-vercel (workflow-server `/v2/runs/:runId/snapshot` endpoints with W3C trace-context injection; delete is 404-idempotent). Inert until the runtime opts in; community World implementations that don't provide `snapshots` are unaffected (the runtime feature-detects and falls back to full replay).
