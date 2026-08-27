---
'@workflow/builders': patch
---

Shim `__dirname`/`__filename` in fully-bundled ESM output so CJS dependencies that reference them at module scope (e.g. `google-gax`) no longer crash the deployed function at init with `ReferenceError: __dirname is not defined in ES module scope`.
