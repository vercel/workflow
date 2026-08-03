---
'@workflow/world-local': patch
---

Shard stream chunks into a directory per stream so a tail reader's poll no longer lists every chunk in the world on each tick, and reliably release its emitter listeners and poll timer when the reader is cancelled. Note: stream chunks are now stored at `streams/chunks/<streamName>/`; chunk files written to the old flat layout by an earlier version are not read back (an acceptable tradeoff for local dev data, and stale flat files are left in place rather than cleaned up).
