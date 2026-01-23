---
"@workflow/core": patch
---

Fix race condition where step would stay pending forever if process crashed between database write and queue write
