---
'@workflow/core': minor
---

The QuickJS WASM VM is now the default workflow engine. Set `WORKFLOW_VM=node` to opt back into the `node:vm` engine. Existing runs keep executing on the engine stamped in their `executionContext` at start.
