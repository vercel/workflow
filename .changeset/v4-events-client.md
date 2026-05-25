---
"@workflow/world-vercel": major
---

Switch the world-vercel adapter's event endpoints from the v2/v3 wire format to v4. Event metadata now rides in `x-wf-*` HTTP headers and payloads stream end-to-end as opaque bytes — no server-side CBOR parse on writes, and no per-event `/refs` round-trip on list responses. POST event response carries the materialized EventResult as a CBOR body. GET single event and LIST events use the same `application/vnd.workflow.v4-frames` binary frame stream; `listEventsByCorrelationId` is wired through too. Public `createWorkflowRunEvent` / `getEvent` / `getWorkflowRunEvents` signatures are unchanged. Requires workflow-server with v4 routes mounted.
