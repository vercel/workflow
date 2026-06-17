---
'@workflow/core': patch
---

Document why `scheduleWhenIdle`'s initial `setTimeout(0)` macrotask is load-bearing and must not be downgraded to a microtask (cross-VM resolve→VM→subscribe ordering). Comment-only; no behavior change.
