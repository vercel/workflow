---
'@workflow/core': patch
---

Enforce `maxRetries` for steps that time out. A step killed by the function timeout writes no error, so retries were previously unbounded; the retry ceiling is now enforced from the event-log start count (inline) and the queue delivery count (background) before each attempt runs.
