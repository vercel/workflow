---
'@workflow/core': patch
---

Serialize a `DataView` as the bytes it views. It previously fell through to devalue's built-in encoding, which persists the whole backing `ArrayBuffer` — for a view onto Node's pooled `Buffer` allocator, unrelated process memory.
