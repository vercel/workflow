---
"@workflow/world-local": minor
---

Support experimental start-hook admission (event-first): `run_created` atomically claims the hook token, claims are retained for their TTL after hook disposal or run completion, and cancellation releases claims the workflow never materialized.
