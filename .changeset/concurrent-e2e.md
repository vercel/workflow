---
---

chore(tests): re-enable `describe.concurrent` in the e2e suite to cut CI wall-clock per workbench, and isolate diagnostic tracking state per-task so concurrent tests no longer clobber each other's `trackedRuns` (each failing test now surfaces its own run's diagnostics, and every tracked run is logged with `[trackRun] <test> → <runId>` for stdout correlation even when diagnostics fetching fails).
