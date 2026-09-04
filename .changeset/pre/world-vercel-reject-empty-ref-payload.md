---
"@workflow/world-vercel": patch
---

Validate ref resolve responses (empty, truncated, or `Content-Length`-mismatched bodies) before use, throwing `WorkflowWorldError` instead of corrupting the event log.
