---
'@workflow/core': patch
---

Steps that receive an `AbortSignal` argument no longer pay a per-step queue round-trip: the real-time abort-stream reader opened for such a step is now released when the step finishes, so the step can complete inline instead of reporting pending work on every invocation.
