---
'@workflow/core': patch
---

Step-argument serialization failures now fail the step (a `step_failed` event is written, so a try/catch around the step call observes the `SerializationError`, same as a step-body failure) instead of failing the run from outside the workflow. Uncaught, the error fails the run immediately as a `USER_ERROR` instead of retrying until max queue deliveries.
