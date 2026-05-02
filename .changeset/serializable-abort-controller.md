---
"@workflow/core": patch
"workflow": patch
---

Add serializable `AbortController` and `AbortSignal` support across workflow and step boundaries. Workflow code can now construct an `AbortController`, pass `signal` to steps, and call `abort()` — durable across replays via a hook + stream pair.

**Behavior change:** `AbortError` thrown from inside a step is now wrapped as `FatalError` and skips retry semantics. Previously it went through the normal retry path. This is the right default for cooperative cancellation, but be aware if your steps were relying on retries to recover from transient `AbortError`s (e.g., from `fetch` with a per-call timeout signal). Wrap such errors in `RetryableError` to opt back in.
