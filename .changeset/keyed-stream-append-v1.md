---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Expose canonical keyed stream append for world-local after its per-run ledger proves cross-process ordering, no mixed keyed/unkeyed data, and durable EOF. Keep Postgres unavailable until its service-backed ordering proof is complete.
