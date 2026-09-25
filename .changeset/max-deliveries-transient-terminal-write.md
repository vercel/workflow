---
'@workflow/core': patch
---

Retry the max-deliveries `run_failed`/`step_failed` write and the step handler's workflow re-queue through queue redelivery when they fail transiently (429, 5xx, transport) instead of acking and leaving the run stuck `running`.
