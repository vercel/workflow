---
'@workflow/core': minor
'workflow': minor
'@workflow/world-vercel': minor
'@workflow/utils': minor
---

Add `WORKFLOW_TRACE_MODE` with a new `linked` default: each workflow/step invocation span is now its own trace root with span links to the delivery and run-origin contexts, instead of one trace spanning the entire run. world-vercel now explicitly injects W3C `traceparent`/`tracestate`/`baggage` headers on outgoing workflow-server requests.

Span names are also friendlier: workflow and step spans now use the short function name (e.g. `workflow.execute processOrder`, `step.execute chargeCard`, `workflow.start processOrder`) instead of the uppercase prefixes and full machine names (`WORKFLOW_V2 workflow//./src/jobs/order//processOrder`). The full name remains available in the `workflow.name` / `step.name` span attributes, and new `workflowDisplayName` / `stepDisplayName` helpers are exported from `@workflow/utils`.

Behavioral changes to telemetry under the new default (set `WORKFLOW_TRACE_MODE=continuous` to restore the previous trace shape exactly; the span-name change applies in both modes):

- A run no longer shares one trace ID: the trace of the request that called `start()` no longer contains the workflow's execution spans — navigate via span links or the `workflow.run.id` attribute instead.
- Sampling decisions are made independently per invocation root (previously one parent-based decision covered the whole run), and the number of root spans/traces increases to one per invocation.
- `workflow.execute`/`step.execute` invocation spans (formerly `WORKFLOW_V2`/`STEP`) become parentless roots, which changes parent/child-based queries and service-map edges.
- Re-enqueued queue messages forward the original run-origin trace carrier unchanged, rather than each invocation's current context.
- Queries or dashboards matching the old `WORKFLOW_V2 ...`/`STEP ...` span names must switch to the new names.
- The queue-delivered `workflow.execute` span kind changed from `internal` to `consumer`, matching the queue-delivered `step.execute` span (this applies in both modes).

Existing attributes and baggage keys are unchanged, and everything remains a no-op when no OpenTelemetry SDK is registered.
