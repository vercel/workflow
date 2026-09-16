---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Route unrecognized backend connection and stream failures through existing retry policies, preserving event-write retries and rebuilding shared event connections after repeated HTTP/2 failures. Keep invalid request headers and caller cancellations out of event-write retries. Include error cause chains in run-failure logs to expose underlying socket, DNS, and TLS failures.
