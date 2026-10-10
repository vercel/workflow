---
"@workflow/core": minor
---

Add opt-in `WORKFLOW_PARALLEL_HOOK_WAKE`, which publishes a `resumeHook()` wake concurrently with its `hook_received` write, and have hook-wake consumers fence their replay until that write is readable.
