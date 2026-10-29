---
"@workflow/world-postgres": patch
---

Send one `NOTIFY` per `streams.writeMulti()` batch instead of one per chunk, and let readers load the whole batch with one range query.
