---
"@workflow/world-vercel": minor
---

Keep a run's events WebSocket open for `WORKFLOW_EVENTS_TRANSPORT_WS_LINGER_MS` (default 10s, `0` disables) after each delivery so the next delivery for the run reuses it, and send writes over HTTP instead of waiting on a socket that is still connecting.
