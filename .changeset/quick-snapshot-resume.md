---
"@workflow/core": patch
---

QuickJS resumes of snapshotted runs take the delta from the setup preload instead of listing it again, and start the snapshot read alongside the setup request when the instance has seen the run at the snapshot threshold (`WORKFLOW_SNAPSHOT_PREFETCH=0` disables the early read).
