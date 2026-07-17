---
'@workflow/world-vercel': patch
---

Cancel the v4 event frame stream when a reader stops early, so the response body's undici connection returns to the pool instead of leaking.
