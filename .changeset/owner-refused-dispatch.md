---
"@workflow/core": patch
---

Retry a remote step within about a second when the platform refuses its invocation before any worker receives it, instead of waiting for the attempt timeout.
