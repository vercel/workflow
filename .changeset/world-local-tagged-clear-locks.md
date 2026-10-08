---
"@workflow/world-local": patch
---

Make a tagged `clear()` delete only its own tag's lock files, so it no longer reopens another tag's disposed hooks mid-run.
