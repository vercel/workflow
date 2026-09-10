---
'@workflow/core': patch
---

Drain consecutively consumable replay events in a single synchronous pass instead of one `process.nextTick` per event, removing O(N) macrotask hops from replay.
