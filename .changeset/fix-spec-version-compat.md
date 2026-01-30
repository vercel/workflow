---
"@workflow/core": patch
"@workflow/cli": patch
"@workflow/world-vercel": patch
---

Fix specVersion handling in start() and resume hook: use opts.specVersion in event payload, pass v1Compat to serialization. Fix missing leading slash in v2 events endpoint.
