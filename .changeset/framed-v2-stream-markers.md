---
"@workflow/core": minor
"@workflow/world": minor
---

Stream chunks now carry per-writer framed-v2 markers so readers deduplicate retransmitted chunks, and stream writes can grant the backend retransmit-safe delivery via `writeMulti` options.
