---
"@workflow/core": patch
---

Treat an empty `VERCEL_URL` as not running on Vercel, so a `.env.local` left behind by `vercel env pull` no longer makes local runs fail with `Invalid URL`
