---
'@workflow/core': patch
---

`experimental_setAttributes` now resolves via an in-process replay instead of a queue re-invocation, removing a delivery round-trip before subsequent steps.
