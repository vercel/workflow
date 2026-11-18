---
'@workflow/world-local': patch
---

Read a stream a bounded batch of chunks at a time, as its consumer asks for them, instead of loading every unread chunk when the reader opens. `clear()` also deletes the run data an earlier release left in the data directory (only the tag's files for a tagged World).
