---
"@workflow/world-vercel": patch
---

Wait out a throttled (429) write recording a step body's outcome until the invocation's deadline instead of 30 seconds, and resend a throttled event-log read from its cursor instead of restarting it.
