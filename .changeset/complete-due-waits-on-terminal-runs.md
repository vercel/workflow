---
'@workflow/core': patch
---

Record a wait's `wait_completed` when its queue message comes due even if the run has already finished, instead of acknowledging the delivery with the wait left open in the log
