---
'@workflow/core': patch
'workflow': patch
---

Retain workflow execution across passive-data inline steps within one invocation; boundaries whose argument serialization could execute workflow code fall back to replay, and `WORKFLOW_RETAINED_VM=0` disables retention. `crypto.subtle.digest` in workflow functions now computes synchronously via `node:crypto`, so digest timing is deterministic under replay. `WeakRef`, `FinalizationRegistry`, `Atomics.waitAsync`, and async `WebAssembly` compilation are no longer exposed in workflow functions (GC observation and wall-clock timing cannot be replayed), and the serialization-relevant intrinsics (`Object`/`Array`/`Function`, the prototypes of `Map`/`Set`/`Date`/typed arrays/`ArrayBuffer`, and reducer-referenced global bindings) are frozen in the workflow sandbox.
