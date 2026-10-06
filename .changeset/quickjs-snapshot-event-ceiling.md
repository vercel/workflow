---
"@workflow/core": patch
---

Exempt snapshotting QuickJS runs from the per-run event ceiling.

The World advertises a per-run event ceiling and the runtime is what enforces it, failing a run with `MAX_EVENTS_EXCEEDED` once its log reaches it. The ceiling exists because a replay re-reads the whole log and re-executes the workflow from the top, so a log that grows without bound eventually cannot be replayed inside one invocation. `WORKFLOW_SNAPSHOT_THRESHOLD` removes that premise: the QuickJS engine restores the VM and replays only the events recorded since its last snapshot, so resume cost no longer scales with log length — yet those runs were still being failed at the ceiling.

A run executing under the QuickJS engine with a snapshot threshold above `0` is now exempt, whether that policy was stamped into its `executionContext` at `start()` or comes from the workflow handler's `WORKFLOW_VM` / `WORKFLOW_SNAPSHOT_THRESHOLD` (which a World cannot see, so its advertised ceiling cannot account for it). `WORKFLOW_MAX_EVENTS_OVERRIDE` takes precedence over the exemption and remains the way to bound such a run.
