---
"@workflow/swc-plugin": patch
---

Restore export validation for file-level `"use step"` files: only function exports (sync or async) are allowed; non-function exports (constants, classes, re-exports) emit an error
