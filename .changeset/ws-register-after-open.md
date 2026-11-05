---
'@workflow/world-vercel': patch
---

Only take the WebSocket events transport once its handshake has completed. A
write issued mid-connect now goes over HTTP instead of waiting for the socket,
which measured faster for the first write of a run.
