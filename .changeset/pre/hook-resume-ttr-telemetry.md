---
'@workflow/core': patch
'@workflow/world': patch
---

Add OTEL telemetry for hook-triggered time-to-resume: `workflow.resume.total_ms` plus a non-overlapping phase breakdown, on the first durable step after a resume.
