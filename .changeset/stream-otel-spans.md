---
"@workflow/world-vercel": patch
---

Add OTEL stream spans: `workflow.stream.write` for writes; for reads, `workflow.stream.read.connect` (network connect) plus `workflow.stream.read` carrying client-observed end-to-end time-to-first-chunk (`workflow.stream.read.ttfc_ms`, includes the network hop). Additive OTEL only.
