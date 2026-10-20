---
"@workflow/world-postgres": minor
---

Queue refused `experimental_lock()` acquisitions in FIFO order and hand freed slots straight to the head of the queue (`locks.fifo`), with migration `0029_add_lock_waiters`.
