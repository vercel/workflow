---
'@workflow/world-vercel': patch
'@workflow/world': patch
'@workflow/core': patch
---

Adopt slot event ids on the Vercel world. New runs are created at spec version 6, which makes their events densely numbered per run and lets a write report the log positions it skipped over instead of forcing a reload. Runs created before this keep their existing event ids. A World may now declare a spec version above the runtime default, up to the highest one the runtime can read.
