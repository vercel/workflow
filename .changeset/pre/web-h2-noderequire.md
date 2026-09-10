---
'@workflow/web': patch
---

Fix run and event observability pages hanging (~16s) and showing no data in the bundled server build, caused by HTTP/2 requests failing to reach `node:http2`.
