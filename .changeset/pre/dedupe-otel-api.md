---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Move client-observed stream telemetry to core: `chunk_rtt` on the flush span, `connect_ms` on the read span, and new `workflow.stream.close` and `workflow.stream.read.complete` spans. Dedupe `@opentelemetry/api` to one workspace instance.
