---
"@workflow/world-local": minor
---

Rename the loopback delivery headers from the Vercel Queues names (`x-vqs-*`) to `x-workflow-queue-name`, `x-workflow-message-id`, `x-workflow-message-attempt`, `x-workflow-message-delivery-count` and `x-workflow-message-created-at`. For one release the queue sends both sets and the route reads either, so an app, a CLI or a web UI on the previous release and one on this release keep understanding each other.
