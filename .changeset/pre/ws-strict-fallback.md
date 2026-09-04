---
'@workflow/world-vercel': patch
---

Add `WORKFLOW_INTERNAL_EVENTS_TRANSPORT_STRICT`, an internal flag that fails a
`step_completed` write which falls back to HTTP while the WebSocket gate is on,
so CI can tell a working socket from a silently demoted one.
