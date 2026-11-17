---
"@workflow/world-local": patch
"@workflow/utils": patch
---

Stop Turbopack from tracing the app's `.gitignore` and from warning that the whole project is traced. A Next.js app deployed from the Vercel CLI could fail with `ENOENT: no such file or directory, lstat '.../.gitignore'` when its build came from cache.
