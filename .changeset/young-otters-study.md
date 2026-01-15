---
"@workflow/core": patch
"@workflow/swc-plugin": patch
---

Fix step attempting to serialize `this` value in contexts where it shouldn't
