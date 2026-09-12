---
'@workflow/swc-plugin': patch
---

Fix a crash ("Cannot redefine property: classId") when a bundler pipeline re-runs the transform over its own output for a dependency that ships custom serialization methods, such as `@ai-sdk/gateway`.
