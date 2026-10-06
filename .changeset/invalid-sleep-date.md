---
"@workflow/utils": patch
---

`sleep()`, `RetryableError`'s `retryAfter`, and a hook's `experimental_minRetention` now throw on an Invalid Date, or on a duration that ends past the latest time a `Date` can hold, instead of sending the Invalid Date to the World.
