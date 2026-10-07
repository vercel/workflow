---
"@workflow/core": patch
---

Start an inline step body without waiting for the `hook_created` write of an `AbortController` created in the same suspension; the step's terminal event, queued-step dispatch, and step-side `abort()` still wait for it (`WORKFLOW_DEFER_ABORT_HOOK_CREATION=0` restores the old behavior).
