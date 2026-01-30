---
"@workflow/core": patch
"@workflow/cli": patch
---

Fix specVersion handling in start() and resume hook: use opts.specVersion in event payload, pass v1Compat to serialization
