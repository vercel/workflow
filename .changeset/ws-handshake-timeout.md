---
"@workflow/world-vercel": patch
---

Bound the events WebSocket handshake by the request timeout, and close the channel when a handshake or a write over it times out, so later event writes fall back to HTTP instead of hanging until `maxDuration`.
