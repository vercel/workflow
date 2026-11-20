---
"@workflow/world-postgres": patch
---

`streams.get()` with a positive `startIndex` no longer reads the payloads of the chunks it skips; the skipped rows come back with only their id and EOF flag, so resuming near the tail of a long stream transfers only the unread suffix
