---
'@workflow/world-local': minor
'@workflow/world-postgres': minor
---

`start()` now accepts `StartOptions { onRestart }` and supports cancelling in-flight runs at boot (`onRestart: 'cancel'`) in addition to recovering them. `ensureWorldStarted()` uses this to cancel runs from a previous session in development — where the workflow code has likely changed and replaying would diverge — while still recovering them in production.
