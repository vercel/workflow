---
'@workflow/core': patch
'@workflow/cli': patch
---

When running `start({ deploymentId })` cross-deploy, stamp the new run with the spec version that the target deployment reports on its capability probe, instead of the caller's own
