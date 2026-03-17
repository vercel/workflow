---
"@workflow/swc-plugin": patch
---

Fix closure variable detection for `new` expressions, exclude module-level declarations from being over-captured, preserve original step function bodies in enclosing functions for direct calls, and walk into nested function/method bodies to detect deeply nested closure variable usage
