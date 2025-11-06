---
"@workflow/errors": patch
---

Fix RetryableError to treat numeric retryAfter values as milliseconds (consistent with sleep()) instead of seconds.

**Breaking Change**: If you were using numeric `retryAfter` values, you need to multiply them by 1000 to convert from seconds to milliseconds. String durations (like `"5s"`) and Date objects are unaffected.

Example migration:
```typescript
// Before
throw new RetryableError("Error", { retryAfter: 5 }); // 5 seconds

// After
throw new RetryableError("Error", { retryAfter: 5000 }); // 5000 milliseconds = 5 seconds
// OR use a string duration (preferred)
throw new RetryableError("Error", { retryAfter: "5s" });
```
