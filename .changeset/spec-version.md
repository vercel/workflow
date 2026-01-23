---
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/world-vercel": patch
"@workflow/web-shared": patch
---

Add `specVersion` property to World interface

- All worlds expose `@workflow/world` package version for protocol compatibility
- Stored in `run_created` event and `WorkflowRun` schema
- Displayed in observability UI
