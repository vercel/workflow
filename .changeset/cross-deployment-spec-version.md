---
'@workflow/core': patch
---

Stamp cross-deployment `start({ deploymentId })` runs with the spec version the target deployment reports on its capability probe (capped at the caller's), instead of the caller's own. A probe miss falls back to the lowest supported spec version, and `recreateRunFromExisting` no longer pins a replay that is redirected to another deployment to the source run's spec version.
