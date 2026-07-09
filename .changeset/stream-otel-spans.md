---
"@workflow/world-vercel": patch
---

Add OTEL stream spans. Writes: `workflow.stream.write` with `workflow.stream.write.e2e_ms` (client→server round-trip). Reads: `workflow.stream.read.connect` (network connect) plus `workflow.stream.read` carrying client-observed end-to-end time-to-first-chunk (`workflow.stream.read.ttfc_ms`, includes the network hop). Additive OTEL only.
