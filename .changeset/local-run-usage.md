---
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/cli': patch
---

Count a run's usage on the Local World (its events by type, each step function and hook, and its storage, counted the way Vercel's Data Written counts it) and print it with `workflow inspect run <id> --usage`.
