---
'@workflow/core': minor
'workflow': minor
'@workflow/world-vercel': minor
---

Add `WORKFLOW_TRACE_MODE` with a new `linked` default that creates each workflow/step invocation span as its own trace root linked to the delivery and run-origin contexts (instead of one giant trace per run); set `WORKFLOW_TRACE_MODE=continuous` to restore the previous behavior. world-vercel now explicitly injects W3C `traceparent`/`tracestate`/`baggage` headers on outgoing workflow-server requests.
