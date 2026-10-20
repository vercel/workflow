---
"@workflow/world-local": minor
---

Queue refused `experimental_lock()` acquisitions in FIFO order and hand freed slots straight to the head of the queue (`locks.fifo`; `WORKFLOW_LOCKS_FIFO=0` keeps polling).
