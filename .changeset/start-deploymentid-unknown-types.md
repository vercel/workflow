---
"@workflow/core": patch
---

Make `start()` return `Run<unknown>` with `unknown[]` args when `deploymentId` is provided, since the deployed workflow version may have different types
