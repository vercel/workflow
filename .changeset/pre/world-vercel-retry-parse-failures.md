---
'@workflow/world-vercel': patch
---

Retry transient response-body read/decode failures (truncated or terminated streams, gateway non-CBOR bodies) on idempotent requests inside the HTTP client, so a sporadic `events.list` parse failure no longer surfaces as a fatal error.
