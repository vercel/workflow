---
'@workflow/world-local': patch
---

Shard stream chunks into a directory per stream so a tail reader's poll no longer lists every chunk in the world on each tick, and reliably release its emitter listeners and poll timer when the reader is cancelled.
