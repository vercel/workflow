---
'@workflow/world-local': minor
'@workflow/world-postgres': minor
---

`start()` now accepts `StartOptions { onRestart }` and supports cancelling in-flight runs at boot (`onRestart: 'cancel'`) in addition to recovering them. `ensureWorldStarted()` uses this to cancel runs from a previous session in development — where the workflow code has likely changed and replaying would diverge — while still recovering them in production. **Behavior change for self-hosted development:** restarting a dev server previously left in-flight runs dormant (`pending`/`running` but never delivered); those runs are now terminally cancelled at restart, with the reason recorded on the `run_cancelled` event. Set `WORKFLOW_RECOVER_IN_DEV=1` to recover them instead, or `WORKFLOW_SKIP_BOOT_RECOVERY=1` to leave them untouched.
