---
"@workflow/core": patch
---

Runtime uses event-sourced entity creation

- Suspension handler creates entities via `events.create()`
- Track `hasCreatedEvent` flag to avoid duplicate event creation on replay
- Handle `hook_conflict` events during replay to reject duplicate token hooks
