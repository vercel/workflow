---
"@workflow/world-vercel": patch
---

Carry the stage-2 `experimental_lock()` wire fields (`lockWake`, `lockHandoffs`, `lock_failed`), with `locks.fifo` behind `WORKFLOW_VERCEL_EXPERIMENTAL_LOCKS_FIFO=1`.
