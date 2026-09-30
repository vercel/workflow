---
"@workflow/core": patch
---

Dynamic `start()` now publishes the run only after `run_created` confirms its code was stored, so a refused or failed create can no longer leave an executing run behind.
