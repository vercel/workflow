---
'@workflow/core': patch
'workflow': patch
---

Retain workflow execution across inline steps within one invocation; `WORKFLOW_RETAINED_VM=0` disables retention. `crypto.subtle.digest` in workflow functions now computes synchronously via `node:crypto`, so digest timing is deterministic under replay. `WeakRef`, `FinalizationRegistry`, `Atomics.waitAsync`, and async `WebAssembly` compilation are no longer exposed in workflow functions (GC observation and wall-clock timing cannot be replayed).
