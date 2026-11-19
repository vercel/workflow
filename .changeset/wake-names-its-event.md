---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
---

A `resumeHook()` wake names the `hook_received` it was sent for, so a spec 9 orchestrator delivery in a process that already consumed the run's log below that event skips the tail read that checks for a no-op wake.
