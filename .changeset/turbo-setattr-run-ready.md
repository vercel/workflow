---
'@workflow/core': patch
---

Fix a turbo-mode race where `experimental_setAttributes` called from a step body could be written before the workflow run was created.
