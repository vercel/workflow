---
'@workflow/core': patch
'@workflow/world': patch
---

Keep the skipped-slot report of a batch whose first rate limit write is refused or sent again, so events another writer appended below it still reach the run.
