---
'@workflow/core': minor
---

Add opt-in `WORKFLOW_ASYNC_STEP_COMPLETED=1`: defer a single sequential inline step's `step_completed` write so the next replay iteration (and, under optimistic start, the next step's body) overlaps it, with all subsequent durable writes and the queue ack ordered behind the deferred write. Only engages with no open hook or wait, on turbo's first delivery — the one case where no concurrent orchestrator invocation can exist.
