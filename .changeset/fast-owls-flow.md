---
"@workflow/core": patch
---

perf: parallelize suspension handler and refactor runtime

- Process hooks first, then steps and waits in parallel to prevent race conditions
- Refactor runtime.ts into modular files: `suspension-handler.ts`, `step-handler.ts`, `helpers.ts`
- Add otel attributes for hooks created (`workflow.hooks.created`) and waits created (`workflow.waits.created`)
- Update suspension status from `pending_steps` to `workflow_suspended`
