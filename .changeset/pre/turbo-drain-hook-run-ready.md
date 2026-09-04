---
'@workflow/core': patch
---

Fix a turbo-mode race where a fire-and-forget hook, wait, or attribute created by a workflow that completes synchronously could be written to the server before the run was created.
