---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/web-shared': patch
---

Add an optional reason to run cancellation (`run.cancel({ cancelReason })`), recorded on the cancellation event and shown in the run detail view.
