---
'@workflow/cli': minor
---

Add `workflow migrate temporal` and `workflow migrate cloudflare-workflows`.

- **Temporal:** workflows become `"use workflow"` functions, proxied activities become `"use step"` functions carrying the proxy's retry policy, and signals become hooks that keep the original handlers and `condition()` checks.
- **Cloudflare Workflows:** each `WorkflowEntrypoint` class becomes a `"use workflow"` function and each `step.do()` callback a `"use step"` function taking the variables it captured. Cloudflare's retry limits and durations carry over, `step.waitForEvent()` reads events from the run's start Hook, and the report includes a drop-in adapter for Workflow bindings.
- **`workflow migrate inngest`:** a const options object that escapes into another container is now a TODO rather than read as final, and an unannotated rest parameter is typed as the tuple of the remaining inputs.
- **Schedules and `continueAsNew`:** cron and schedule triggers (Cloudflare Cron Triggers and `scheduled()` handlers, Temporal `client.schedule.create()`) are reported with a Vercel Schedules replacement. Temporal's `continueAsNew()` is flagged as unnecessary: keep the run going on the QuickJS engine.
