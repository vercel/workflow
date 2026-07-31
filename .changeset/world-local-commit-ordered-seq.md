---
'@workflow/world-local': minor
'@workflow/core': patch
---

Commit-ordered event positions for the filesystem world: every event append is serialized by a per-run, cross-process on-disk append lock; a dense per-run `seq` and a tail-dominant event key are allocated at the publish point, so `(createdAt, eventId)` order == seq order == commit order == visibility order and a cursor reader can never skip a late-committing event. world-local now enforces the `stateEventCount` decision fence (412 before anything is written) and declares `capabilities.preconditionGuard`. The runtime additionally re-asserts `seq` contiguity on the merged replay log immediately before the VM runs, covering the inline write-response delta and `run_started` preload paths that bypass the paginated loader.
