---
'@workflow/core': patch
---

Retained owners re-arm the in-process sleep timer when a durable wake arrives early, and report the sleep-wake enqueue as a `durable_wake` diagnostics span.
