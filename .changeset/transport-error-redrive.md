---
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Treat transient workflow-server transport failures (exhausted RetryAgent / `UND_ERR_REQ_RETRY`, dropped sockets, timeouts, firewall 429 challenges) as retryable: surface them as a `WorkflowWorldError` and redeliver via the queue — with backoff that ramps toward the visibility window — instead of failing the run. Stop retrying 429 in-process so firewall challenges surface immediately with the `x-vercel-mitigated` / `x-vercel-id` diagnostics rather than amplifying load.
