---
'@workflow/core': patch
---

Step-argument serialization failures now fail the step with a catchable `SerializationError` (via a `step_failed` event, like a step-body failure) instead of failing the run from outside the workflow, and when uncaught they fail the run immediately as a `USER_ERROR` rather than retrying until max queue deliveries.
