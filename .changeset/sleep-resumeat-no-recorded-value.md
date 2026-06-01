---
'@workflow/core': patch
---

Fix a spurious `CorruptedEventLogError` on replay when a duration-based `sleep()`'s `wait_completed` is validated without a recorded `wait_created` value.
