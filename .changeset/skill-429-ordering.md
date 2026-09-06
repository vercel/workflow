---
---

Check for 429 before the general 4xx branch in the workflow skill's error handling example. As written the 4xx branch caught 429 first and threw `FatalError`, so the `RetryableError` line below it could never run and a rate limited request would never be retried.
