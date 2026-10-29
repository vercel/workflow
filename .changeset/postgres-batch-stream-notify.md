---
"@workflow/world-postgres": patch
---

Send a `streams.writeMulti()` batch's notifications in one statement and let readers load the whole batch with one range query, while older readers still receive every chunk.
