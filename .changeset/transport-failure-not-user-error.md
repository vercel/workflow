---
'@workflow/world-vercel': patch
---

Classify every `fetch` failure that produced no response as a retryable `TRANSPORT` error, instead of only the ones whose code is in a fixed allowlist. A `TypeError: fetch failed` used to propagate raw for an unlisted cause (h2 session errors, TLS failures, `ENETUNREACH`, a happy-eyeballs `AggregateError`), which the runtime then failed the run over as `USER_ERROR` without redelivering it. Request-construction faults (malformed URL, invalid header) still propagate raw.
