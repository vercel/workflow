---
"@workflow/world-vercel": patch
---

Name the stream write/read client spans for their operation (`workflow.stream.write` / `workflow.stream.read`) and tag them with `workflow.run.id`, `workflow.stream.name`, `workflow.stream.operation`, and `workflow.stream.start_index`, so stream latency is sliceable per run/stream in traces. Additive OTEL only — no behavior change when no OpenTelemetry SDK is registered.
