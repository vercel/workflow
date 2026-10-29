---
"@workflow/world-vercel": minor
---

Single-owner runs write through workflow-server's eventsync WebSocket: contiguous event prefixes are committed in order on one connection, with flush-through durability barriers and catch-up from the committed head. `WORKFLOW_EVENTSYNC_POOL` keeps connections open ahead of use. A write-pacing rejection (`throttled`) is backpressure: the owner waits the advised `Retry-After`, reconnects and resends. Direct invocation is on by default on Vercel (this deployment's generated invoke route, or `WORKFLOW_VERCEL_INVOKE_URL`, which may be a bare origin such as a service binding), and its logs record the platform's `x-affinity` outcome.
