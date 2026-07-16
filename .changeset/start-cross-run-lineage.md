---
"@workflow/core": patch
"@workflow/world": patch
---

Record cross-run lineage when `start()` is called from inside a workflow or step: the new run is tagged with `$parentRunId` (its direct parent) and inherits the parent's `$rootRunId`, so a daisy chain or fan-out of any depth groups under one root id.
