---
'@workflow/core': minor
'workflow': minor
---

Speed up `await run.returnValue` by waiting on a run-scoped system stream signal instead of a fixed ~1s poll, cutting up to a second of quantization latency for a run that finishes mid-interval. This is **on by default** and works uniformly across every World (each already implements streams): at a run's terminal transition the runtime writes a tiny marker to a `strm_..._system_return` stream and closes it, and the waiter — which opens the stream at index 0 — catches up on that marker (or the close) even if it attaches after the fact. The run record stays the source of truth: every wake re-reads it. A slow fallback poll (`WORKFLOW_RETURN_VALUE_FALLBACK_POLL_MS`, default 5s) backstops any missed signal, and `WORKFLOW_RETURN_VALUE_STREAM=0` is an emergency kill switch that restores the exact fixed 1s poll.
