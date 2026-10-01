---
'@workflow/world-vercel': patch
---

Add `WORKFLOW_EVENTS_TRANSPORT_WS_OVERRIDE_WORKFLOWS`, a comma-separated list of workflows whose runs use the WebSocket events transport even when `WORKFLOW_EVENTS_TRANSPORT` is `http` or unset.
