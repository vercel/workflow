---
"@workflow/swc-plugin": patch
---

Rewrite anonymous `export default class` to a `const` declaration so the class has an accessible binding name for serde/step registration code
