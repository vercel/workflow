---
"@workflow/core": patch
"@workflow/world-local": patch
---

Improve OpenTelemetry tracing instrumentation

- Add W3C trace context headers to step queue messages for cross-service trace linking
- Add `peer.service` and RPC semantic conventions for external service attribution
- Add `step.hydrate` and `step.dehydrate` spans for argument serialization visibility
- Add `workflow.replay` span for workflow event replay tracking
- Rename `queueMessage` span to `queue.publish` following OTEL messaging conventions
- Add OTEL baggage propagation for workflow context (`workflow.run_id`, `workflow.name`)
- Add span events for milestones: `retry.scheduled`, `step.skipped`, `step.delayed`
- Enhance error telemetry with `recordException()` and error categorization (fatal/retryable/transient)
- Use uppercase span names (WORKFLOW, STEP) for consistency with HTTP spans
- Add world-local OTEL instrumentation matching world-vercel
