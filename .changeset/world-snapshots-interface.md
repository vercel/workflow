---
'@workflow/world': minor
'@workflow/world-local': minor
'@workflow/world-postgres': minor
'@workflow/world-vercel': minor
---

Add a `snapshots` storage interface (`save`/`load`/`delete` + `SnapshotMetadata`) for VM-memory snapshotting, with implementations in world-local (filesystem sidecar files), world-postgres (`workflow_snapshots` table), and world-vercel (workflow-server `/v2/runs/:runId/snapshot` endpoints with W3C trace-context injection). Inert until the runtime opts in; community World implementations must add the new `snapshots` member.
