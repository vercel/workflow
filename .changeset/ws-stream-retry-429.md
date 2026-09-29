---
"@workflow/world-vercel": patch
---

Retry throttled (429) stream WebSocket writes and closes after `Retry-After`, moving to HTTP when the socket closes or the wait budget runs out, and retry a close 5xx over HTTP instead of failing the writer.
