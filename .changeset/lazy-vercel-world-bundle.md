---
'@workflow/next': patch
---

Bundle `@workflow/world-vercel` into the Next.js server output instead of leaving it external, so cold starts no longer resolve its module graph from disk one file at a time.
