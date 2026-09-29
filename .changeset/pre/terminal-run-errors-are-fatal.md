---
'@workflow/errors': patch
'@workflow/core': patch
---

Mark `WorkflowRunFailedError` and `WorkflowRunCancelledError` as non-retryable, so a step that reads a terminal run's `returnValue` fails on its first attempt with the error intact instead of exhausting its retry budget first.
