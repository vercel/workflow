---
'@workflow/core': patch
---

Fix false-positive unconsumed `step_created` errors when replay resumes a `for await` hook loop and appends more async work after the first promise-queue drain.
