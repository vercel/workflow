---
"@workflow/core": patch
---

A spec 9 delivery that resumes a parked VM takes the `hook_received` its own process's `resumeHook()` just wrote as its read when it continues the parked log, so it reads neither the log nor the run.
