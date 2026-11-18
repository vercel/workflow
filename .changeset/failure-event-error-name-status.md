---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Record the failed error's class name and HTTP status in plaintext on `run_failed`, `step_failed` and `step_retrying` (`errorName`, `errorStatus`), never its message or stack.
