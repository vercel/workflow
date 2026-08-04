---
'@workflow/world-vercel': minor
'@workflow/world-local': minor
'@workflow/world-postgres': minor
'@workflow/world': minor
'@workflow/errors': minor
'@workflow/core': minor
'workflow': minor
---

Number new runs' events by position instead of by ULID, in every World, so a reader can prove its copy of an event log is complete. A creation whose position another writer already took is rejected with a `SlotConflictError`, and the runtime merges the events it was missing, replays, and claims a free position. Correlation IDs now come from a sequence per entity type rather than one shared across all of them, so creating a hook or a sleep no longer renames the steps after it.
