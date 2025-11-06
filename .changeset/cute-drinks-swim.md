---
"@workflow/core": patch
---

**BREAKING**: Change `RetryableError` "retryAfter" option number value to represent milliseconds instead of seconds. Previously, numeric values were interpreted as seconds; now they are interpreted as milliseconds. This aligns with JavaScript conventions for durations (like `setTimeout` and `setInterval`).
