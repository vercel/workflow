---
'@workflow/core': minor
---

Add in-process VM continuation (on by default; kill switch `WORKFLOW_VM_CONTINUATION=0`). The inline replay loop now keeps a suspended workflow VM alive and feeds newly-appended events into it for step-only suspensions, instead of rebuilding the `vm.Context` and replaying the event log from scratch each pass. Falls back to a full replay on any prefix divergence or non-step suspension, so the kill switch restores the previous behavior exactly.
