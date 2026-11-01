---
"@workflow/world-local": patch
---

Restart recovery now dispatches steps that were running inline when the previous process exited right away instead of after the 860s inline-ownership lease, and `releaseOrphanedSteps(runId)` exposes the same release to embedders that recover runs themselves.
