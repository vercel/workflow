---
'@workflow/core': patch
---

Fix a turbo-mode race where step-body writes (`experimental_setAttributes` and stream writes via `getWritable`) could reach the server before the workflow run was created.
