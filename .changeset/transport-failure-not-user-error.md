---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Classify response-less fetch failures as retryable transport errors while preserving fail-fast handling for request-construction faults. Include error cause chains in run-failure logs to expose underlying socket, DNS, and TLS failures.
