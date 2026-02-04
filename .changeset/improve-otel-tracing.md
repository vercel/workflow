---
"@workflow/core": patch
"@workflow/world-vercel": patch
---

Add improved OpenTelemetry instrumentation for better workflow observability:

- Add tracing to HTTP requests in world-vercel with method, endpoint, and status attributes
- Add tracing to storage operations (runs, steps, events, hooks) 
- Add tracing to event loading with event count and pages loaded attributes
- Add queue timing breakdown attributes (deserialize, execution, serialize times) to step handler
- Add new semantic conventions for world/storage, events, serialization, and queue breakdown
