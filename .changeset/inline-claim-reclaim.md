---
'@workflow/core': patch
---

Keep a batch of inline steps together when one of its event writes loses a race, instead of discarding the batch
