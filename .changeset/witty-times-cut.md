---
"@workflow/core": patch
---
Retry an initial missing event history once after the concurrent run lookup succeeds, avoiding an unnecessary queue redelivery.
