---
'@workflow/core': patch
'@workflow/cli': patch
---

Stamp cross-deployment `start({ deploymentId })` runs with the spec version the target deployment reports on its capability probe (capped at the caller's), instead of the caller's own. The probe now waits up to 10 seconds (it returns as soon as the target answers), so a cold target is still read correctly. A probe miss falls back to spec version 6, logs a warning once per process, and records `workflow.run.spec_version_source` on the `start()` span. `attributes` and `experimental_retention` aimed at a target whose version predates them now throw, naming the target, instead of creating a run the target cannot execute. `recreateRunFromExisting` no longer pins a replay that is redirected to another deployment to the source run's spec version; such replays are capped at the replaying process's own version. `wf inspect` replay caps its probed spec version the same way.
