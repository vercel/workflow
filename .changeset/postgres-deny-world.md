---
"@workflow/world": minor
---

Add `'deny'` to `QueueAuthMode`, the flow route's in-process entry contract (`IN_PROCESS_QUEUE_HANDLER`, `InProcessDelivery`, whose optional `signal` says when the World stopped waiting (the runtime's route does not act on it, as it does not on a request's signal), `QueueRouteHandler`, `QueueDeliveryMeta`) and the delivery header helpers (`queueDeliveryHeaders()`, `readQueueDeliveryHeaders()`). The headers a self-hosted World sends over HTTP are named `x-workflow-*`; the earlier `x-vqs-*` names are read, and sent alongside, for one release.
