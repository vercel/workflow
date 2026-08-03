---
'@workflow/core': minor
---

Record the source run on replays: `recreateRunFromExisting` now stamps `replayedFromRunId` into the new run's `executionContext` (and `start` accepts a matching option) so tooling can surface a run as a replay and link back to its origin.
