---
'@workflow/core': minor
'workflow': minor
---

Publish `diagnostics_channel` tracing events around step execution: a `TracingChannel` named `workflow.step` fires start/end/asyncStart/asyncEnd/error per step attempt with metadata-only payload (run id, step id, step name, workflow name, attempt, fatal-vs-retryable classification). Zero overhead with no subscribers; no OpenTelemetry dependency required to consume.
