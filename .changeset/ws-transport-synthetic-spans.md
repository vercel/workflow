---
'@workflow/world-vercel': patch
---

Restore the per-event client span on the WebSocket events transport (`WORKFLOW_EVENTS_TRANSPORT=ws`). Each event write now emits a synthesized `http POST` CLIENT span with the same name, kind and `url.full` as the HTTP path — plus `workflow.events.transport`, `network.protocol.name`, `workflow.events.ws.url` and `workflow.events.ws.req_id` so a synthetic span is never mistaken for a real request. The WebSocket handshake gets its own `workflow.events.ws.connect` span, and injects trace context from inside it. The HTTP path is unchanged apart from gaining `workflow.events.transport: 'http'` and `workflow.event.type`.
