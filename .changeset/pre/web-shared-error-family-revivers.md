---
"@workflow/web-shared": patch
---

Fix "Unknown type FatalError" / "Failed to load resource details" in the o11y UI by adding the missing reviver entries (`FatalError`, `RetryableError`, the built-in `Error` subclasses, `AggregateError`, and `DOMException`) to `getWebRevivers()` so it stays in sync with the runtime reducer set.
