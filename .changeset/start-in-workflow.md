---
"@workflow/core": patch
"workflow": patch
---

Add support for calling `start()` directly inside workflow functions with full `Run` object support — `run.status`, `run.returnValue`, `run.cancel()`, and other `Run` properties all work in workflow context via step-backed execution
