---
'@workflow/core': patch
'@workflow/builders': patch
'@workflow/next': patch
---

Ship a build-time V8 code cache alongside large workflow bundles so a cold serverless instance skips parsing the bundle on its first replay, cutting time-to-first-step.
