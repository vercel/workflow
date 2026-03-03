---
'@workflow/world-vercel': patch
---

Fix `run_failed` event schema validation error by using separate wire schemas for resolve vs lazy `remoteRefBehavior` modes. Resolve mode retains the strict `WorkflowRunSchema` discriminated union for type safety, while lazy mode uses the looser `WorkflowRunWireBaseSchema` with `deserializeError()` normalization.
