---
"@workflow/world-vercel": patch
---

Retry throttled (429) stream WebSocket writes and closes after `Retry-After`, falling back to HTTP when the socket closes, and retry a close 5xx over HTTP instead of failing the writer.
