---
"@workflow/world-vercel": patch
---

Add a default request timeout to workflow-server HTTP calls so hung responses can't burn compute up to the function's `maxDuration`. Timeouts now surface as `WorkflowWorldError` and are handled by existing catch sites.
