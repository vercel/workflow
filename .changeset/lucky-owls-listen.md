---
'@workflow/world-vercel': patch
---

Bound the inline structured error carried in v4 event metadata so a multi-megabyte error message or stack no longer makes the server reject `step_retrying` / `step_failed` / `run_failed` writes
