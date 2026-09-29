---
'@workflow/world-vercel': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Upgrade undici to 7.30.0, which stops a failed HTTP/2 stream from leaving a phantom in-flight request on its connection.
