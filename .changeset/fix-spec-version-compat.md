---
"@workflow/core": patch
"@workflow/cli": patch
"@workflow/world-vercel": patch
"@workflow/web-shared": patch
---

Fix specVersion handling in start() and resume hook: use opts.specVersion in event payload, pass v1Compat to serialization. Fix missing leading slash in v2 events endpoint. Fix schema validation error when fetching legacy v1 runs (accept both Uint8Array and JSON for input/output). Fix recreateRun to preserve legacy specVersion.
