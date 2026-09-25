---
"@workflow/core": patch
---

`start()` with an explicit `deploymentId` (and so `recreateRunFromExisting`, i.e. Replay Run) no longer fails in a process that is not itself a deployment; it takes the cross-deployment path instead.
