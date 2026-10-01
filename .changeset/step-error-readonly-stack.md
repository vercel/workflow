---
'@workflow/core': patch
---

Errors with a read-only `stack`, such as postgres.js query errors, are now reported as thrown instead of being replaced by `Cannot assign to read only property 'stack'`.
