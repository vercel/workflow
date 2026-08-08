---
'@workflow/world-vercel': minor
'@workflow/next': patch
---

Add an opt-in WebSocket transport for event writes during step execution (`WORKFLOW_EVENTS_TRANSPORT=ws`), as an alternative to the existing HTTP path. Defaults to HTTP; no behavior change unless explicitly enabled.

Also externalizes `ws`'s optional native accelerators (`bufferutil`, `utf-8-validate`) in webpack builds so `ws` still bundles and falls back to its pure-JS implementation when those packages aren't installed.
