---
'@workflow/core': patch
---

QuickJS engine: serialization now runs entirely on the host through `JSValueHandle`s (quickjs-wasi 3.3 introspection primitives + devalue 5.9 pluggable operations), replacing the serde bundle previously evaluated inside the VM. Wire format is unchanged; classification and extraction are side-effect free (engine brand checks, boot-captured intrinsics, descriptor reads), matching the node:vm engine's architecture.
