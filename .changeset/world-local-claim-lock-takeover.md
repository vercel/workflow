---
"@workflow/world-local": patch
---

Take over a Hook token claim lock left by a dead process at once, instead of after 30 seconds, and create claim and in-band fence locks with their owner recorded in one atomic step, so a process exit never leaves a lock that can only go stale.
