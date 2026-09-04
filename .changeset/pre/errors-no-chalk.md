---
"@workflow/errors": patch
---

Replace the `chalk` import in `@workflow/errors/ansi` with a tiny inline ANSI shim. `@workflow/errors/ansi` is reachable from the workflow-VM bundle (via `@workflow/core/workflow` → `context-errors` → `context-violation-error` → here), and `chalk` pulls in `supports-color`, which calls `require('os')` at module load — crashing every workflow with `ReferenceError: require is not defined` in the sandboxed VM.
