---
"@workflow/core": patch
---

Retry lazy-discovery workflow registration misses before failing runs

- Treat `WorkflowNotRegisteredError` as transient for a bounded retry window when `WORKFLOW_NEXT_LAZY_DISCOVERY=1`
- Re-enqueue workflow queue deliveries with backoff instead of immediately writing `run_failed`
