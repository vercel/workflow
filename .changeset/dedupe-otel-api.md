---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Emit client-observed stream RPC latencies from core (proven export path): `workflow.stream.write.chunk_rtt` on the flush span, `workflow.stream.read.connect_ms` on the read span, and a new `workflow.stream.close` span. Dedupe `@opentelemetry/api` to a single workspace instance and add DEBUG-gated OTEL diagnostics in world-vercel.
