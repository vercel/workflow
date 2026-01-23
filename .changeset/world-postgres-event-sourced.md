---
"@workflow/world-postgres": patch
---

Implement event-sourced entity creation in `events.create()`

- Atomically create run/step/hook entities when processing corresponding events
- Return `hook_conflict` event when hook token already exists
- Add `spec_version` column to runs table
