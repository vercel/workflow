---
"@workflow/web-shared": patch
"@workflow/web": patch
---

Fix new trace viewer getting stuck on the first page: re-wire pagination so it auto-loads pages up to an event cap and scroll-loads the rest for very large runs.
