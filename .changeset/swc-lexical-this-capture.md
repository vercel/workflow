---
"@workflow/swc-plugin": patch
---

Capture lexical `this` for nested arrow `"use step"` functions: workflow mode wraps the proxy with `.bind(this)`, and step mode hoists the body as a regular `function` so the runtime can rebind `this` via `stepFn.apply(thisVal, args)`. Requires the enclosing class to have custom serialization.
