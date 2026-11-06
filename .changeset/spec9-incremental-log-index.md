---
"@workflow/core": patch
---

Spec 9 node engine: keep the loaded event log's ids, highest slot and hole check in an incremental index, so an in-band write no longer rescans the whole log. On 2000 sequential inline steps in one delivery, time per step drops from about 18 ms to about 12 ms in the in-memory benchmark.
