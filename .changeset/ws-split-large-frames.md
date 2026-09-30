---
'@workflow/world-vercel': patch
---

The WebSocket events transport now limits the size of each message. Any frame over `WORKFLOW_WS_MAX_MESSAGE_BYTES` (default 12 MiB, at most 16 MiB) is sent as several messages and rebuilt by the receiver. The client offers `frame-parts` in the `x-workflow-ws-flags` upgrade header so the backend can split large replies too.
