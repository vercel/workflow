---
'@workflow/core': minor
'@workflow/errors': minor
'@workflow/world': minor
'@workflow/world-local': minor
'@workflow/world-postgres': minor
---

Add an `experimental_retention` option to `start()`: `experimental_retention: 0` asks the World to delete the run's user data as soon as the run completes or fails, while keeping the run itself listable. Implemented on the Vercel, Postgres and Local Worlds. Reading a run whose data has expired now throws `RunExpiredError` instead of resolving to a placeholder.
