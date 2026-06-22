---
'@workflow/core': minor
---

Precompile the workflow bundle `vm.Script` at module-init time via a new optional `workflowFilenames` option on `workflowEntrypoint`, so the first queue delivery's replay skips the bundle parse/compile cost.
