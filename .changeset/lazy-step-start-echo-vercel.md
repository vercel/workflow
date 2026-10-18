---
"@workflow/world-vercel": patch
---

Skip echoing a lazy `step_started`'s own input back in the response when it is 64,000 bytes or more (`WORKFLOW_SKIP_STEP_INPUT_ECHO=0` disables).
