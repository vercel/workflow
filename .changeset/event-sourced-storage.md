---
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/web-shared": minor
"@workflow/cli": minor
"@workflow/core": minor
"@workflow/errors": minor
"@workflow/serde": minor
"@workflow/swc-plugin": minor
"@workflow/utils": minor
"@workflow/web": minor
"workflow": minor
"@workflow/world": minor
"@workflow/world-postgres": minor
"@workflow/world-testing": minor
---

**BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`

- Remove `cancel`, `pause`, `resume` from `runs`
- Remove `create`, `update` from `runs`, `steps`, `hooks`
- Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
- Add `step_created` event type
- Remove `fatal` field from `step_failed` (terminal failure is now implicit)
- Add `step_retrying` event with error info for retriable failures
