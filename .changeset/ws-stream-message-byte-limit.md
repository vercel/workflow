---
'@workflow/world-vercel': patch
---

Split stream WebSocket write groups by encoded message bytes as well as chunk count, bounded by `WORKFLOW_WS_MAX_MESSAGE_BYTES` (default 12 MiB, at most 16 MiB).
