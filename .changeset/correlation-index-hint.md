---
"@workflow/world-local": patch
---

Look up events by correlation ID through `events_by_correlation`, so `hook_created` writes and `events.listByCorrelationId` no longer read every event in the run.
