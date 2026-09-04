---
'@workflow/core': patch
---

Fix `createHook()` conflicting with the run's own disposed hook when a token is reused after `dispose()` within the same run
