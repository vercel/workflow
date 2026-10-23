---
"@workflow/world-postgres": patch
---

Preserve the first delivery time when a keyed queued message is published again, so an immediate duplicate cannot erase a delayed retry's backoff.
