---
"@workflow/nitro": patch
---

Coalesce workflow rebuilds requested while one is running in Nitro dev. A burst of file changes now triggers at most one follow-up rebuild instead of one per change, so the dev server settles sooner.
