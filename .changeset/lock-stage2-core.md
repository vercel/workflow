---
"@workflow/core": minor
"workflow": minor
---

On a World with `locks.fifo`, `experimental_lock()` waiters queue and are woken by the releasing run instead of polling, and a full waitlist rejects with `LockWaitlistFullError`.
