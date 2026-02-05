---
"@workflow/world-vercel": patch
---

Improve world-vercel OTEL telemetry

- Use parent application's 'workflow' tracer instead of separate service name
- Add `peer.service` and RPC semantic conventions for Datadog service maps
- Include event type in `world.events.create` span names (e.g., `world.events.create step_started`)
