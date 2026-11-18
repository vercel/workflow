---
"@workflow/world": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/world-vercel": minor
---

New runs on supported worlds (Vercel, Local, Postgres, and any third party worlds implementing it) will use specVersion 9 for major performance and cost improvements. Worlds that don't implement specVersion 9 will keep creating specVersion 8 runs.
