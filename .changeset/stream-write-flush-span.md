---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Emit a client-observed `workflow.stream.flush` span per flushed stream-write batch, with a `buffer_dwell_ms` attribute separating client-side batching cost from network/server time (the per-request `workflow.stream.write` RPC span keeps its own name). Also log under `DEBUG=workflow:*` when `@opentelemetry/api` fails to load in world-vercel, so silently missing spans are diagnosable.
