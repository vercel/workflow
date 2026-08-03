---
'@workflow/web-shared': major
---

Remove the legacy trace viewer, superseded by the new trace viewer. This drops the `RunTraceView` and `WorkflowTraceViewer` exports; use `NewTraceViewer` instead. The shared `Span`, `SpanEvent`, and `Trace` types now live in `lib/trace-types` and are still exported from the package root.
