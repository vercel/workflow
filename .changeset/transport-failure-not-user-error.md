---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Route unrecognized backend connection failures through existing retry policies instead of immediately failing the workflow as a user error. Include error cause chains in run-failure logs to expose underlying socket, DNS, and TLS failures.
