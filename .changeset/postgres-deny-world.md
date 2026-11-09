---
"@workflow/world": minor
---

Add `'deny'` to `QueueAuthMode`, the flow route's in-process entry contract (`IN_PROCESS_QUEUE_HANDLER`, `InProcessDelivery` with its optional `signal`, `QueueRouteHandler`, `QueueDeliveryMeta`) and the delivery header helpers (`queueDeliveryHeaders()`, `readQueueDeliveryHeaders()`). The headers a self-hosted World sends over HTTP are named `x-workflow-*`; the earlier `x-vqs-*` names are read, and sent alongside, for one release.
