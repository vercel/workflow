---
'@workflow/core': patch
'workflow': patch
---

Serializing values built inside the workflow VM no longer executes workflow code, using engine brand checks and host intrinsics captured at boot.
