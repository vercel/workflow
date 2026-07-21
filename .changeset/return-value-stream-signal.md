---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-vercel': minor
'workflow': minor
---

Add an opt-in fast path for `await run.returnValue` that waits on a run-scoped system stream signal instead of a fixed ~1s poll, cutting up to a second of quantization latency. Gated behind `WORKFLOW_RETURN_VALUE_STREAM` (default off) and the new `returnValueSignalStream` World capability (declared by world-vercel); a slow fallback poll always backstops the signal, so behavior is unchanged when the flag is off or the World lacks the capability.
