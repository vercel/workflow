---
'@workflow/world-vercel': minor
'@workflow/core': minor
'@workflow/errors': minor
'@workflow/world': minor
'workflow': minor
---

Event creations on runs that number events by slot now claim their own event id and merge, replay and re-claim when a `SlotConflictError` shows another writer took it first.
