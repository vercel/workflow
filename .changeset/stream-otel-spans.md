---
"@workflow/core": patch
"@workflow/world-vercel": patch
---

Add OTEL stream latency spans. Writes (`@workflow/world-vercel`): `workflow.stream.write` with `workflow.stream.write.e2e_ms` (client→backend round-trip), plus `workflow.stream.read.connect` for the read's network-connect leg. Reads (`@workflow/core`): `workflow.stream.read` carrying the client-observed end-to-end time-to-first-chunk (`workflow.stream.read.ttfc_ms`, includes the network hop), emitted from the core reader when the first chunk reaches the consumer. Additive OTEL only.
