---
"@workflow/core": patch
---

Spec 9: the QuickJS engine (`WORKFLOW_VM=quickjs`) now runs ahead of its writes as the node engine does, on by default with `WORKFLOW_RUN_AHEAD_DEPTH` (default 10, `0` turns it off). At a boundary no other writer can change, an inline step's outcome reaches the workflow before its `step_completed` commits, and the next steps' creations go out ahead in one batch while their bodies start. If another writer takes a slot a speculative write was placed at, QuickJS restarts the delivery in place from a fresh load, with run-ahead off for the rest of it. The node engine repairs such a write in place instead.
