---
'workflow': minor
'@workflow/core': minor
---

Add experimental `WORKFLOW_CALLSITE_CORRELATION_IDS=1`, which derives correlation IDs from the call site that created the entity instead of from a per-run sequence, so two concurrent replays of the same run agree on IDs even when they disagree about an event.
