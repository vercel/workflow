---
"@workflow/world-vercel": patch
---

Fix world-vercel telemetry to use parent application's tracer

The world-vercel package was creating spans under a separate 'workflow-world-vercel' service name, causing HTTP spans for workflow-server API calls (step_started, step_completed) to be filtered out when viewing traces for the main application service. Now uses the same 'workflow' tracer name as @workflow/core to ensure all spans are reported under the parent application's service.
