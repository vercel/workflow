---
'@workflow/world-vercel': patch
---

Restore the per-event client span on the WebSocket events transport (`WORKFLOW_EVENTS_TRANSPORT=ws`), and add a `workflow.events.ws.connect` span for the handshake. Event write spans now carry `workflow.events.transport` and `workflow.event.type` on both transports.
