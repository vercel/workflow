---
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Use explicit flush-through controls with timed canonical eventsync batching. Pipeline step completion as well as input/create/start, validate owned step transitions locally, and expose actual server commit-group diagnostics. Preserve the existing transport path and fail-stop durability barriers.
