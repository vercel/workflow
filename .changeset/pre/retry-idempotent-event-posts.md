---
'@workflow/world-vercel': patch
---

Retry transient transport failures (e.g. `UND_ERR_REQ_RETRY`, `ECONNRESET`, socket timeouts, 5xx) in-process for idempotent-on-retry event POSTs, so a brief network blip after a step completes no longer re-executes the step. `step_started`, `step_retrying`, and `hook_received` are excluded as they are not safe to blindly retry.
