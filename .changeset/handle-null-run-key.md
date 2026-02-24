---
"@workflow/world-vercel": patch
---

Handle `{ key: null }` response from the run-key API endpoint, returning `undefined` to signal encryption is disabled for that workflow run
