---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Route unrecognized backend connection and stream failures through existing retry policies, rebuilding shared event connections after repeated HTTP/2 failures. Keep invalid backend URLs, blocked ports, and unsupported request headers out of those retries. Include error cause chains in run-failure logs to expose underlying socket, DNS, and TLS failures.
