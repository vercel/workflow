---
'@workflow/errors': minor
'@workflow/core': patch
'@workflow/cli': patch
'@workflow/web-shared': patch
'@workflow/world-vercel': patch
'workflow': minor
---

Add a catchable `StreamError` and classify Workflow stream infrastructure failures as `STREAM_ERROR` instead of `USER_ERROR`.
