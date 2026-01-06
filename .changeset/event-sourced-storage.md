---
"@workflow/world": patch
---

**BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`

- Remove `cancel`, `pause`, `resume` from `runs`
- Remove `create`, `update` from `runs`, `steps`, `hooks`
- Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
- Add `step_created` event type
- Remove `fatal` field from `step_failed` (terminal failure is now implicit)
- Add `step_retrying` event with error info for retriable failures
