---
'@workflow/core': patch
'workflow': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Gate World event batching on the explicit `eventsCreateBatch` capability so
independently rolled clients fail closed while retaining the existing
single-event fallback.
