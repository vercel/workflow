---
"@workflow/world-local": patch
---

Register a run's stream names under a lock so `streams.list` no longer drops a stream when several of the run's streams first write at once.
