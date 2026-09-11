---
"@workflow/swc-plugin": patch
---

Fix `arguments` being incorrectly captured as a closure variable in nested `function`-form step bodies, which previously produced invalid output.
