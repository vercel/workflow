---
'@workflow/core': patch
'workflow': patch
---

Deterministic sandbox hardening: `crypto.subtle.digest` in workflow functions now computes synchronously via `node:crypto` (byte-identical values, deterministic timing under replay); `Atomics.waitAsync`, async `WebAssembly` compilation, `WeakRef`, and `FinalizationRegistry` are no longer exposed (wall-clock timing and GC observation cannot be replayed); and the sandbox pins the surfaces serialization dispatch resolves through: `Object.prototype`/`Array.prototype`/`Function.prototype` are frozen and serialization-relevant global bindings are non-writable. Built-in prototypes and constructor statics remain patchable, so polyfills (Temporal, core-js) keep working.
