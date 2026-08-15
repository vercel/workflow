---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Keep world-local keyed stream append unavailable until its per-run ledger proves cross-process ordering, no mixed keyed/unkeyed data, and one canonical ordinary EOF across close races. Postgres remains unavailable pending service-backed ordering proof.
