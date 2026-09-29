---
'@workflow/core': patch
---

Retry the max-deliveries `run_failed` write through queue redelivery when it fails transiently (429, 5xx, transport) instead of acking and leaving the run stuck `running`.
