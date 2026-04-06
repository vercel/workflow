---
"@workflow/next": patch
---

Remove unused `dataDir` option from `withWorkflow()` config. The option was accepted in the type but never read.
