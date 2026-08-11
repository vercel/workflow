---
'@workflow/core': patch
---

QuickJS engine: divergence-detection and write-fencing parity with the node:vm engine. Replays now arbitrate the event log at each fixed point (orphaned events, stepName/token/resumeAt mismatches) and escalate `ReplayDivergenceError` through the existing recovery machinery instead of silently delivering wrong payloads or surfacing corruption as `USER_ERROR`; all replay-context event writes now carry the optimistic-concurrency precondition snapshot (closing the documented KNOWN GAP), with `run_failed` left unfenced to match the node engine.
