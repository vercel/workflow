---
"@workflow/builders": patch
"@workflow/nest": patch
"@workflow/vitest": patch
---

Stop workflow discovery from losing imports silently, which caused builds to miss some workflows that then failed to start. Better following of js-to-ts import rewrites. Stop reading template-literal text as imports.

Fail a production build when the workflow manifest cannot be created, instead of warning and reporting success.
