---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
---

Fold new events returned by `events.create` into the replay log so a completed wait no longer needs a follow-up `events.list` round trip
