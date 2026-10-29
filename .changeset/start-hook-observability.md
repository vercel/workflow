---
'@workflow/web-shared': patch
'@workflow/cli': patch
---

Show a run's start Hook token and its `hook_created` (from `run_created`) in the timeline, and revive `WorkflowStartError`; CLI re-runs never forward a start Hook. Ship this before or with the SDK release: older dashboards and CLIs cannot revive the new error.
