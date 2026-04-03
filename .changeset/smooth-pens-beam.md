---
"@workflow/swc-plugin": patch
---

Fix class expression method registrations to use binding name instead of internal class name, preventing `ReferenceError` at runtime for pre-bundled packages
