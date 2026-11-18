---
"@workflow/core": patch
"@workflow/world-postgres": patch
---

Keep spec 9 orchestrator deliveries alive through short sleeps instead of re-invoking for each one, and lower the default `WORKFLOW_ORCHESTRATOR_LINGER_MS` to 5 seconds
