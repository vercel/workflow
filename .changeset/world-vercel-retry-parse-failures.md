---
'@workflow/world-vercel': patch
---

Retry transient response-body read/decode failures (truncated or terminated streams, gateway non-CBOR bodies) on idempotent requests inside the HTTP client, with bounded exponential backoff, so a sporadic `events.list` parse failure recovers in-process instead of surfacing as an error.
