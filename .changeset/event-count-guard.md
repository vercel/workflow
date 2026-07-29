---
'workflow': minor
'@workflow/core': minor
'@workflow/world-vercel': minor
'@workflow/world': minor
'@workflow/errors': minor
---

Strengthen the event-creation precondition guard: replay-context writes now also send the number of loaded events, so a snapshot that is missing an event is rejected instead of committing a divergent event log, and a rejection restarts the replay in-process (consuming the events a world may attach to the rejection) rather than re-committing the rejected payload or re-invoking over the queue. `@workflow/world-local` and `@workflow/world-postgres` do not implement the check.
