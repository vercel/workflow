---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Route unrecognized backend connection failures through existing retry policies, and rebuild shared event connections after repeated HTTP/2 failures. Include error cause chains in run-failure logs to expose underlying socket, DNS, and TLS failures.
