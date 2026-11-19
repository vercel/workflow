---
"@workflow/world-postgres": patch
---

A zero-retention run's data is purged after its terminal write commits, so a race's loser settling at the same moment can no longer deadlock the purge. A backstop job committed with the terminal write retries the purge if the process stops first or the purge fails; any deployment's workers run it, and Kubernetes scaling and pruning keep the run's version until it has run.
