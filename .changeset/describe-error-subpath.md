---
"@workflow/core": patch
---

Expose `describeError` plus a new data-driven `describeRunError({ errorCode, errorName })` helper under the `@workflow/core/describe-error` subpath, so CLI / web observability renderers can derive user-vs-SDK framing from persisted failure events without needing the original `Error` instance.
