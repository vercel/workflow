---
"@workflow/world-postgres": patch
---

A zero-retention run's data is purged after its terminal write commits, so a race's loser settling at the same moment can no longer deadlock the purge, and a backstop job committed with the terminal write retries the purge if the process stops before it completes or it fails.
