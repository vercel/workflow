---
'@workflow/world-vercel': patch
---

Propagate W3C trace context (`traceparent` / `tracestate` / `baggage`) on v4 event requests. The v4 event path (`createEvent` / `getEvent` / `listEvents`) routes through `fetchV4`, which bypasses the `makeRequest` path where trace-context injection lives — so v4 event traffic from the flow route did not propagate context to workflow-server, and workflow-server spans could not join the invocation's trace (while v2/v3 reads/writes did). `fetchV4` now injects the active context, matching `makeRequest`. No-op when no OpenTelemetry SDK is registered.
