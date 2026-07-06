---
"@workflow/world-postgres": minor
---

Support experimental start-hook admission (event-first): a new `workflow_hook_claims` table backs single-owner hook tokens; `run_created` claims the token in the same transaction as run and event creation, claims are retained for their TTL after hook disposal or run completion, and cancellation releases claims the workflow never materialized.
