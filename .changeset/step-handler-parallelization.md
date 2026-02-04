---
"@workflow/core": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
---

Optimize step handler performance by removing initial world.steps.get() call

Add server-side retryAfter validation to local and postgres worlds to match workflow-server behavior. When a step has a retryAfter timestamp that hasn't been reached, step_started will now return HTTP 425 with the retryAfter timestamp in the response.
