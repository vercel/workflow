---
'@workflow/world-vercel': patch
---

The WebSocket events transport now works where a single WebSocket message is size-limited. Any frame over `WORKFLOW_WS_MAX_MESSAGE_BYTES` (default 12 MiB) is sent as several messages and rebuilt by the receiver, in both directions.
