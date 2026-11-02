---
"@workflow/world-postgres": patch
---

Every keyed job now keeps its first scheduled delivery time (`preserve_run_at`), so an immediate duplicate cannot erase a delayed retry's backoff.
