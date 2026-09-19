---
"@workflow/world": patch
"@workflow/core": patch
"@workflow/world-vercel": patch
---

Allow owner-scoped event sessions to supply canonical initialization reads. The eventsync transport loads the run, paginated history and steps over the same connection as writes, without falling back to HTTP. Other storage backends and the existing execution path retain their normal read APIs.
