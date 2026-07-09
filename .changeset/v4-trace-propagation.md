---
'@workflow/world-vercel': patch
---

Inject W3C trace context (`traceparent`/`tracestate`/`baggage`) on v4 event requests, which previously bypassed it via `fetchV4` — restoring workflow-server span correlation for traffic from the flow route. No-op when no OpenTelemetry SDK is registered.
