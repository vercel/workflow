---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/web-shared': patch
---

Add an optional reason to run cancellation (`run.cancel(reason)`), recorded on the cancellation event and shown in the run detail view.
