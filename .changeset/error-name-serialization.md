---
"@workflow/core": patch
"@workflow/errors": patch
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-vercel": patch
"@workflow/world-postgres": patch
---

Preserve error `name` through the serialization pipeline so that `WorkflowNotRegisteredError` and `StepNotRegisteredError` properly rehydrate with their original class names, enabling `.is()` checks to work on rehydrated errors
