---
'@workflow/core': minor
'workflow': minor
---

Add an experimental QuickJS WASM VM engine for workflow execution, opt-in via `WORKFLOW_VM=quickjs` (or per-run `executionContext.workflowVm`). The engine performs the same full event replay as the default `node:vm` engine but runs workflow code in a QuickJS VM compiled to WebAssembly, enabling platforms without `node:vm` support and laying the groundwork for VM-memory snapshotting.
