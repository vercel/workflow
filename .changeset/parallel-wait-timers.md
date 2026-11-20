---
'@workflow/core': patch
---

Send a delivery's wait timers at once rather than one after another, so a run with many open waits (rate limit calls made at once) no longer waits a queue round trip per timer before it waits in process or hands off.
