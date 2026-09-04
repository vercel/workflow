---
'@workflow/core': patch
---

Add a run-pickup watchdog to the e2e harness: a started run still pending after a budget is replaced (side-effect-free) and recorded as an infra event surfaced separately from test failures and flaky retries.
