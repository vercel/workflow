---
'@workflow/core': minor
---

Emit a `faas.instance` OTEL span attribute (a synthesized per-warm-instance id) on the flow and step route spans, so traces can distinguish which compute instance handled each request.
