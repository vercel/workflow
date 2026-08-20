---
'workflow': minor
'@workflow/core': minor
---

Derive correlation IDs from the call site that created the entity instead of from a per-run sequence, so two concurrent replays of the same run agree on IDs even when they disagree about an event. Set `WORKFLOW_CALLSITE_CORRELATION_IDS=0` to opt back into the positional sequence.
