---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Emit a client-observed `workflow.stream.flush` span per stream-write batch, with a `buffer_dwell_ms` attribute separating client-side batching cost from network/server time. Log under `DEBUG=workflow:*` when `@opentelemetry/api` fails to load in world-vercel.
