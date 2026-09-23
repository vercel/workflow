---
"@workflow/world-vercel": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
---

Upgrade `@vercel/queue` to 0.6.0 so queue callbacks for messages that are already claimed or processed (409 / 410) respond 200 instead of logging `Queue callback error` and returning 500
