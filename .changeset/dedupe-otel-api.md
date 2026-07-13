---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Move client-observed stream telemetry from world-vercel to core: `workflow.stream.write.chunk_rtt` on the flush span, `workflow.stream.read.connect_ms` on the read span, and new `workflow.stream.close` and `workflow.stream.read.complete` spans. Dedupe `@opentelemetry/api` to one workspace instance and add DEBUG-gated OTEL diagnostics.
