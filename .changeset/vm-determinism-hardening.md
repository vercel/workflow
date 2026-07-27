---
'@workflow/core': major
'workflow': major
---

Deterministic sandbox hardening: `crypto.subtle.digest` in workflow functions now computes synchronously via `node:crypto` (byte-identical values, deterministic timing under replay); `Atomics.waitAsync`, async `WebAssembly` compilation, `WeakRef`, and `FinalizationRegistry` are no longer exposed (wall-clock timing and GC observation cannot be replayed).
