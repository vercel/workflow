---
'@workflow/world-vercel': minor
'@workflow/next': patch
---

Add an opt-in WebSocket transport for event writes during step execution (`WORKFLOW_EVENTS_TRANSPORT=ws`), as an alternative to the existing HTTP path. Defaults to HTTP; no behavior change unless explicitly enabled.

The transport reconnects eagerly (bounded backoff) after an unexpected close, resolves the auth token once per socket rather than once per event, and fails a write closed rather than reporting success when a reply can't be understood.

Also externalizes `ws`'s optional native accelerators (`bufferutil`, `utf-8-validate`) in webpack builds so `ws` still bundles and falls back to its pure-JS implementation when those packages aren't installed.
