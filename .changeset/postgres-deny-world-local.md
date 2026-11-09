---
"@workflow/world-local": minor
---

Rename the loopback delivery headers from `x-vqs-*` to `x-workflow-*` (`x-workflow-queue-name`, `x-workflow-message-id`, `x-workflow-message-attempt`, `x-workflow-message-delivery-count`, `x-workflow-message-created-at`). For one release the queue sends both sets and the route reads either, so mixed releases keep working.
