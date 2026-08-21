---
'workflow': minor
'@workflow/core': minor
---

Pin correlation-ID draw order to event-log order (Node.js VM engine), so two concurrent replays of the same run assign the same IDs even when one loaded a shorter event-log prefix. Set `WORKFLOW_LOG_ORDER_DRAWS=0` to opt back into arrival-order delivery resolution.
