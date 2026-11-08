---
"@workflow/world": minor
---

Add `'deny'` to `QueueAuthMode`, `Queue.queueAuthModeFor(prefix)`, the flow route's in-process entry contract (`IN_PROCESS_QUEUE_HANDLER`, `InProcessDelivery`, `InProcessQueueHandler`, `QueueRouteHandler`, `QueueDeliveryMeta`) and the delivery header helpers (`QUEUE_DELIVERY_HEADERS`, `LEGACY_QUEUE_DELIVERY_HEADERS`, `queueDeliveryHeaders()`, `readQueueDeliveryHeaders()`): the private wire shape self-hosted Worlds use for a delivery they still send over HTTP is renamed from the Vercel Queues names (`x-vqs-*`) to `x-workflow-*`, with the old names read, and sent alongside, for one release.
