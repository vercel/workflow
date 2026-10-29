---
"@workflow/world-local": patch
---

Serialize a spec 9 run's orchestrator deliveries where they are handled as well as where they are sent, so a `start()` or `resumeHook()` called from another process on the same data directory (a script or test runner) no longer overlaps the app's own deliveries of the run and has its writes refused by the in-band fence.
