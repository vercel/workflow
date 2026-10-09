---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Experimental single-owner runs: a caller opts a run in at `start()` with the reserved run attribute `$experimentalSingleOwner` (and `allowReservedAttributes: true`). Its presence selects the single-owner runner and its single-writer event connection for that run alone; other runs on the same deployment execute as before. On Vercel, its JSON value's optional `vercelAffinity` places several runs of a deployment on one owner. The owner verifies from the run's history that it was invoked under the run's affinity.
