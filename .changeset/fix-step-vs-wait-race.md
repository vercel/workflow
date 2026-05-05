---
"@workflow/core": patch
---

Fix `Promise.race(step, sleep)` semantics in V2 mixed suspensions: when a workflow suspension contains both pending steps and at least one wait (sleep), the runtime now queues every step instead of executing one inline. Inline `await executeStep(...)` blocks the handler for the full step duration, so the wait timer never fires on time — a 1s sleep racing a 10s step would silently resolve to the step. Queueing the step in this case lets the wait timeout drive a continuation in parallel, restoring V1's race semantics.
