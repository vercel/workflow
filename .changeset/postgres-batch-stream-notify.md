---
"@workflow/world-postgres": patch
---

Live stream readers load a `streams.writeMulti()` batch with one range query instead of one query per chunk, while older readers still receive every chunk.
