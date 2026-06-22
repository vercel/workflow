---
'workflow': minor
'@workflow/core': minor
---

Add turbo mode (on by default, disable with `WORKFLOW_TURBO=0`): on the first delivery of a run's first invocation the runtime backgrounds `run_started`, skips the initial event-log load, and forces optimistic inline start so the run reaches its first steps with no preceding network round-trips. It is safe there because the first delivery has no concurrent handler to race; turbo mode deactivates once a hook or sleep is encountered.
