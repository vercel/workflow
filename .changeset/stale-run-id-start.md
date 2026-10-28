---
"@workflow/core": patch
---

Stop redelivering a workflow message whose run was never created and whose run ID is now too old for the backend to create it from `run_started`. The delivery is logged and acknowledged instead of being retried until the queue's delivery limit.
