---
"@workflow/core": patch
"workflow": patch
---

Add serializable `AbortController` and `AbortSignal` support across workflow and step boundaries. Workflow code can now construct an `AbortController`, pass `signal` to steps, and call `abort()`.

**Behavior change:** `AbortError` thrown from inside a step is now wrapped as `FatalError` and skips retry semantics. As a result, custom timeouts on `fetch` inside steps are no longer re-tried by default, and now need to be wrapped in `RetryableError` to preserve the old behavior.
