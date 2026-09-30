---
'@workflow/world-vercel': patch
---

The WebSocket events transport now survives a connection lost while a `step_started` write is in flight: it reconnects, resends the write, and completes it with the server's answer instead of failing the step's delivery.
