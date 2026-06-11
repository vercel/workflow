---
'@workflow/core': minor
'workflow': minor
'@workflow/world-vercel': minor
---

Add `WORKFLOW_TRACE_MODE` with a new `linked` default: each workflow/step invocation span is now its own trace root with span links to the delivery and run-origin contexts, instead of one trace spanning the entire run. world-vercel now explicitly injects W3C `traceparent`/`tracestate`/`baggage` headers on outgoing workflow-server requests.

Behavioral changes to telemetry under the new default (set `WORKFLOW_TRACE_MODE=continuous` to restore the previous shape exactly):

- A run no longer shares one trace ID: the trace of the request that called `start()` no longer contains the workflow's execution spans — navigate via span links or the `workflow.run.id` attribute instead.
- Sampling decisions are made independently per invocation root (previously one parent-based decision covered the whole run), and the number of root spans/traces increases to one per invocation.
- `WORKFLOW_V2`/`STEP` invocation spans become parentless roots, which changes parent/child-based queries and service-map edges.
- Re-enqueued queue messages forward the original run-origin trace carrier unchanged, rather than each invocation's current context.

Span names, existing attributes, and baggage keys are unchanged, and everything remains a no-op when no OpenTelemetry SDK is registered.
