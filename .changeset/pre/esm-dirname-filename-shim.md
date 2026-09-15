---
'@workflow/builders': patch
---

Shim `__dirname`/`__filename` in fully-bundled ESM output so CJS dependencies that reference them at module scope (e.g. `google-gax`) no longer crash the deployed function at init with `ReferenceError: __dirname is not defined in ES module scope`.

CJS dependencies that feature-detect with `typeof __dirname !== 'undefined'` will now take their CJS branch, where `__dirname` resolves to the function root rather than the dependency's original directory.
