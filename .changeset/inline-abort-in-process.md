---
"@workflow/core": patch
---

An abort published by a workflow or a step reaches the inline steps running in the same process directly, so a race's loser on a zero-retention run is still aborted when the run's end clears the abort stream before the step reads it.
