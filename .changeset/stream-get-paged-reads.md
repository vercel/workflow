---
'@workflow/world-postgres': patch
---

Page the historical read in `streams.get` instead of materializing the entire stream: the previous implementation selected every chunk of a stream in a single unbounded query and discarded the first `startIndex` rows in JS, buffering the whole stream in memory before the first byte reached the consumer, which could stall catch-up readers on large streams. The read is now pull-paced in pages of 64: the first page positions itself with a count-bounded OFFSET (so a start index past the current tail still skips live-buffered rows), subsequent pages keyset-paginate on `chunk_id` like `getChunks`, and negative start indexes are resolved with a `count(*)` of data rows. Live NOTIFY buffering, ULID-order dedup, offset skipping (including the EOF marker row), and EOF close semantics are unchanged, and a cancelled stream no longer enqueues from an in-flight page.
