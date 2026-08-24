---
'@workflow/core': minor
---

Mirror replay lineage into the reserved `$replayedFromRunId` run attribute on worlds with native attributes (spec version 4+), alongside the existing `executionContext.replayedFromRunId` record, so attribute-indexed observability stores can surface replays in list queries.
