---
'@workflow/core': patch
---

Retained owners keep a durable monitor wake armed while they hold in-process work, so a lost owner is replaced and its inline steps restart. At the function deadline the owner hands the run to a fresh owner invocation instead of failing it, and it never expires its own running steps. Sleep wakes are enqueued before `wait_created` commits, and in-process sleep timers cover waits up to 30 s.
