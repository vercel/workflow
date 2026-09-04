---
'@workflow/swc-plugin': patch
---

Register class expressions (`var Foo = class { ... }`, `exports.Foo = class { ... }`, `{ Foo: class { ... } }`, etc.) through an IIFE that closes over the class instead of module-level code that references the class by name, and fail the build with a clear error instead of emitting an unresolvable `AnonymousClass` reference when a class with `"use step"` methods or custom serialization has no derivable name or is declared inside a function.
