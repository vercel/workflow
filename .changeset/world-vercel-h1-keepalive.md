---
'@workflow/world-vercel': patch
---

Keep idle HTTP/1.1 sockets pooled for 60s instead of 10s, so hook resumes after a pause skip fresh TCP and TLS handshakes to workflow-server and the queue.
