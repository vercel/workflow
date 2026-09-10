---
'@workflow/world-vercel': patch
---

Honor `WORKFLOW_NODE_HTTP` on the queue client's transport, so a deployment whose bundled undici is unusable can still acknowledge queue messages instead of redelivering them until the invocation is killed.
