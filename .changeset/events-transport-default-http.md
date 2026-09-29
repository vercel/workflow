---
'@workflow/world-vercel': minor
---

Default the events transport back to HTTP. The WebSocket events transport is now opt-in with `WORKFLOW_EVENTS_TRANSPORT=ws`; any other value, including unset or `http`, uses HTTP.
