---
'@workflow/core': patch
---

QuickJS engine: move serialization out of the VM onto the host, replacing the in-VM serde bundle with side-effect-free handle introspection (same wire format, 2–100× faster).
