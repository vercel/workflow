---
"@workflow/core": minor
"workflow": minor
---

Add `resumeHookOrStart(token, payload, workflow, args, options?)` to `workflow/api`. It delivers `payload` to the run that owns `token`, or starts `workflow` as the owner when no run holds it, retrying through racing callers, an owner that just ended, and a start whose outcome is unknown.
