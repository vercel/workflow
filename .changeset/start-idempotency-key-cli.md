---
"@workflow/cli": patch
---

Keep re-runs from forwarding the source run's `start()` idempotency key, and show `WorkflowRunAlreadyStartedError` payloads with their holder in inspect output.
