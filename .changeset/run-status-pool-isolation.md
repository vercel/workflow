---
'@workflow/world-vercel': patch
---

Prevent concurrent run-status long polls from exhausting the HTTP connection pool used by ordinary workflow-server requests.
