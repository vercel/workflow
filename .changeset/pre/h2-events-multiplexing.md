---
'@workflow/world-vercel': patch
---

Event-log requests now multiplex over a single HTTP/2 connection instead of opening one connection per in-flight request
