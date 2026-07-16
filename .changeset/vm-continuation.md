---
'@workflow/core': minor
---

Add experimental in-process VM continuation (`WORKFLOW_VM_CONTINUATION=1`, off by default). When enabled, the inline replay loop keeps a suspended workflow VM alive and feeds newly-appended events into it for step-only suspensions, instead of rebuilding the `vm.Context` and replaying the event log from scratch each pass. Falls back to a full replay on any prefix divergence or non-step suspension, so behavior with the flag off is unchanged.
