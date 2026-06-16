---
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Treat transient workflow-server transport failures — an exhausted RetryAgent (`UND_ERR_REQ_RETRY`, e.g. a firewall shedding load with 429/503), dropped sockets, connect/DNS failures, and timeouts — as retryable: world-vercel maps them to a `TRANSPORT` `WorkflowWorldError`, and the runtime redelivers the queue message for a fast redrive instead of failing the run. Also surface the Vercel firewall `x-vercel-mitigated` (`challenge`/`deny`) header in error diagnostics and logs.
