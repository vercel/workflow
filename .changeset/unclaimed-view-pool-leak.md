---
"@workflow/core": patch
---

Serialize only the viewed bytes of a `Float16Array` (no longer the whole Node `Buffer` pool behind it), and support `Float16Array` in the QuickJS engine with the same wire format as the node:vm engine.
