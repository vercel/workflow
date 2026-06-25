---
'@workflow/core': patch
---

Reject an explicit empty-string `token` in `createHook()`. Omit the option (or pass `undefined`) to get a randomly generated token, or pass a non-empty string.
