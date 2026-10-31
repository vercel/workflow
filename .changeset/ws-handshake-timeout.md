---
"@workflow/world-vercel": patch
---

Bound the events WebSocket handshake, including the token fetch before it, by `WORKFLOW_REQUEST_TIMEOUT_MS`, and close the channel when a handshake or a write over it times out, so later event writes fall back to HTTP instead of hanging until `maxDuration`.
