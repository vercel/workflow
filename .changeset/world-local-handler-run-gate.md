---
"@workflow/world-local": patch
---

Fix a `start()` or `resumeHook()` called from another process on the same data directory (a script or test runner) overlapping the app's own deliveries of the run and getting its writes refused by the in-band fence on spec 9 runs.
