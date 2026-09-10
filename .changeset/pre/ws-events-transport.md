---
'@workflow/world-vercel': minor
'@workflow/builders': patch
'@workflow/rollup': patch
'@workflow/next': patch
---

Add an opt-in WebSocket transport for event writes during step execution, enabled with `WORKFLOW_EVENTS_TRANSPORT=ws`. Defaults to HTTP; no behavior change unless explicitly enabled.
