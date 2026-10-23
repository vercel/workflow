---
"@workflow/world-postgres": minor
---

Support `experimental_lock()`: per-key semaphores with fencing tokens and a FIFO waitlist with direct handoff (migrations `0028_add_lock_tables` and `0029_add_lock_waiters`).
