---
'@workflow/world-local': patch
---

Retry local queue deliveries that fail at the transport (e.g. `fetch failed` / `ETIMEDOUT` when the dev server is saturated by many parallel steps) instead of dropping the message, so steps no longer get stuck never-started under high local concurrency.
