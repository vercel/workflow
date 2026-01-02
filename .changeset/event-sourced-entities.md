---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/world-vercel": patch

"@workflow/web-shared": patch
---

perf: implement event-sourced architecture for runs, steps, and hooks

- Add run lifecycle events (run_created, run_started, run_completed, run_failed, run_cancelled)
- Add step_retrying event for non-fatal step failures that will be retried
- Remove `fatal` field from step_failed event (step_failed now implies terminal failure)
- Rename step's `lastKnownError` to `error` for consistency with server
- Update world implementations to create/update entities from events via events.create()
- Entities (runs, steps, hooks) are now materializations of the event log
- This makes the system faster, easier to reason about, and resilient to data inconsistencies
