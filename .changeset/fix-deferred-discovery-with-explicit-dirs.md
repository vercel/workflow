---
"@workflow/next": patch
---

Remove eager workflow discovery from deferred mode entirely. In deferred mode, workflows are now only discovered through cache restoration and loader socket notifications, not through upfront scanning.
