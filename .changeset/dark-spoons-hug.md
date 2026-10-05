---
"@workflow/world-vercel": patch
---

Make HTTP stream appends replay their complete body after a confirmed 429, while avoiding duplicate chunks by disabling retries after ambiguous connection failures.
