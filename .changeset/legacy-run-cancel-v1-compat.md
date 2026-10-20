---
"@workflow/core": patch
---

`Run.cancel()` now cancels a legacy (spec version 1) run through the legacy cancel endpoint, the way `cancelRun()` already does. It used to send these to the event-sourced route, which has no `run_cancelled` event to write for a run that predates event sourcing, so on the Vercel World the call could fail even though the run was cancelled.
