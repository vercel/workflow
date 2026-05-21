---
"@workflow/world-vercel": major
---

Switch the world-vercel adapter's event endpoints from the v2/v3 wire format to v4. Event metadata now rides in `x-wf-*` HTTP headers and payloads stream end-to-end as opaque bytes — no server-side CBOR parse on writes, and no per-event `/refs` round-trip on list responses. POST event response carries the materialized EventResult as a CBOR body. Public `createWorkflowRunEvent` / `getEvent` / `getWorkflowRunEvents` signatures are unchanged; the underlying wire calls swap to v4. `listEventsByCorrelationId` is not yet implemented on v4 and now throws — callers should fetch hooks directly via `storage.hooks.getByToken`. Requires workflow-server with v4 routes mounted.
