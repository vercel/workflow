---
"@workflow/swc-plugin": patch
---

Fix closure variable detection for `new` expressions, exclude module-level declarations from being over-captured as closure variables, and preserve original step function bodies in enclosing functions so they work when called directly outside workflow context
