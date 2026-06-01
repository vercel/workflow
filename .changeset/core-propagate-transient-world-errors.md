---
'@workflow/core': patch
---

Propagate transient world failures (response-body parse failures, 5xx, and rate limits) to the queue for an automatic retry instead of failing the run. This is the fallback when the adapter's in-process retries are exhausted, or for non-idempotent writes that are never retried in-process; replaying the run is safe because replay is idempotent. Genuine schema-validation contract errors remain fatal.
