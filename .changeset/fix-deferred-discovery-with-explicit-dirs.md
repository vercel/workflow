---
"@workflow/ai": patch
"@workflow/next": patch
---

Remove eager workflow discovery from deferred mode and fix @workflow/ai export conditions. In deferred mode, workflows are now only discovered through cache restoration and loader socket notifications. Added workflow export condition to @workflow/ai/agent to ensure step directives are preserved.
