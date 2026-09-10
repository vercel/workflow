---
'@workflow/swc-plugin': patch
---

Register class expressions through an IIFE that closes over the class instead of module-level code that references it by name, fixing the unresolvable `AnonymousClass` reference emitted for shapes such as `var Foo = class { ... }` in pre-bundled packages.
