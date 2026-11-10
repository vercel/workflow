---
"@workflow/core": patch
"workflow": patch
"@workflow/vitest": patch
---

Deprecate `run.wakeUp()`. It was never meant for application code: every `sleep()` resumes on its own when it is due. To skip sleeps in tests, use the new `skipSleep(run, { correlationIds? })` from `@workflow/vitest`; to end a sleep early in application code, race it against a hook. Operators unsticking a run by hand can use `run.internal_wakeUpRun()`, an internal escape hatch that may change without notice.
