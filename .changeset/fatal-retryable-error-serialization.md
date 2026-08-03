---
"@workflow/core": minor
---

Add first-class serialization for `FatalError` and `RetryableError` so they round-trip with class identity preserved across all serialization boundaries (including from environments that don't run the SWC plugin)
