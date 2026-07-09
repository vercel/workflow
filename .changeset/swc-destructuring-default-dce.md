---
"@workflow/swc-plugin": patch
---

Fix dead-code elimination stripping module-scope declarations referenced only by a destructuring-default initializer (e.g. `const { ttl = TTL } = options;`), which caused a runtime `ReferenceError` when the default fired.
