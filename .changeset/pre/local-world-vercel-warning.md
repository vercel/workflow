---
'@workflow/world-local': patch
---

Warn when the Local World starts inside a Vercel deployment, and fail with an actionable error instead of a confusing `ENOENT` when its data directory cannot be created on a read-only filesystem.
