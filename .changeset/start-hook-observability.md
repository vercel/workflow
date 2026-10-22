---
'@workflow/web-shared': patch
'@workflow/cli': patch
---

Show a run's start Hook token and revive `WorkflowStartError` and `HookReservedError`; CLI re-runs never forward a start Hook. Ship this before or with the SDK release: older dashboards and CLIs cannot revive the two new errors.
