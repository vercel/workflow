---
"@workflow/world-vercel": patch
---

Wait out a throttled (429) `step_completed` or `step_retrying` write until the invocation's deadline instead of 30 seconds, and resend a throttled event-log read from its cursor instead of restarting it.
