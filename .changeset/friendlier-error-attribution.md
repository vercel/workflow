---
"@workflow/core": patch
---

Add presentation-only `describeError` helper that computes user vs SDK attribution + class-aware hints from existing error classes and `RUN_ERROR_CODES`. Terminal logs at step-failure, max-retries, run-failure, and fatal-setup sites now include `errorAttribution` metadata and hint text for well-known error types.
