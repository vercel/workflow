---
"@workflow/swc-plugin": patch
---

Preserve original step function names in stack traces by setting `Object.defineProperty(fn, "name", ...)` in the IIFE registration
