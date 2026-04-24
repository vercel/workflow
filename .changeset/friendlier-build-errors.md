---
"@workflow/errors": patch
"@workflow/builders": patch
---

Add `WorkflowBuildError` (with optional `hint`) and apply it to user-facing build-time failures in `@workflow/builders`: failed esbuild phases, unresolved built-in steps, and empty esbuild output now include a hint pointing at the likely fix.
