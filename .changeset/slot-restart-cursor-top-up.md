---
'@workflow/core': patch
'workflow': patch
---

Recover faster from a concurrent write on runs that number their events by slot, by topping the event log up from its cursor instead of reloading it in full
