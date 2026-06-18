---
'@workflow/core': minor
'workflow': minor
'@workflow/world-vercel': minor
'@workflow/utils': minor
---

Add `WORKFLOW_TRACE_MODE` with a new `linked` default: each workflow/step invocation stays a child of its local delivery (flow-route) context — so one invocation (route handler, replay, inline steps, event writes) is a single bounded trace — with a span link to the run-origin context. The run-origin context is a link, never a parent, and re-enqueues forward the original carrier unchanged, so a long-running run is never stitched into one giant trace across invocations. world-vercel now explicitly injects W3C `traceparent`/`tracestate`/`baggage` headers on outgoing workflow-server requests.

Span names are also friendlier: workflow and step spans now use the short function name (e.g. `workflow.execute processOrder`, `step.execute chargeCard`, `workflow.start processOrder`) instead of the uppercase prefixes and full machine names (`WORKFLOW_V2 workflow//./src/jobs/order//processOrder`). The full name remains available in the `workflow.name` / `step.name` span attributes, and new `workflowDisplayName` / `stepDisplayName` helpers are exported from `@workflow/utils`.

Behavioral changes to telemetry under the new default (set `WORKFLOW_TRACE_MODE=continuous` to restore the previous trace shape exactly; the span-name change applies in both modes):

- A run no longer shares one trace ID: each delivery is its own bounded trace and the trace of the request that called `start()` no longer contains the workflow's execution spans — navigate via the run-origin span link or the `workflow.run.id` attribute instead.
- Sampling decisions are made independently per delivery (previously one parent-based decision covered the whole run), and the number of traces increases to one per invocation.
- `workflow.execute`/`step.execute` invocation spans (formerly `WORKFLOW_V2`/`STEP`) are no longer parented to the run-origin context, which changes parent/child-based queries and service-map edges across invocations.
- Re-enqueued queue messages forward the original run-origin trace carrier unchanged, rather than each invocation's current context.
- Queries or dashboards matching the old `WORKFLOW_V2 ...`/`STEP ...` span names must switch to the new names.
- The queue-delivered `workflow.execute` span kind changed from `internal` to `consumer`, matching the queue-delivered `step.execute` span (this applies in both modes).

Existing attributes and baggage keys are unchanged, and everything remains a no-op when no OpenTelemetry SDK is registered.
