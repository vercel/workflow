---
"@workflow/core": patch
"@workflow/errors": patch
---

Replace `util.inspect`'s default object dump for runtime structured-log metadata with an opinionated, workflow-aware formatter. The runtime logger uses color-coded metadata blocks.
