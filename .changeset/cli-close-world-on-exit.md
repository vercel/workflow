---
"@workflow/cli": patch
---

Call `World.close()` after CLI commands complete so the process exits cleanly without relying on `process.exit()`
