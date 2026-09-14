---
'@workflow/core': patch
---

Render the `errorStack` field as the log body when the message carries no stack of its own, so the run-failure log shows the stack instead of discarding it.
