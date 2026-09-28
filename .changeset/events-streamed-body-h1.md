---
'@workflow/world-vercel': patch
---

Send event requests with bodies too large to re-buffer over HTTP/1.1 so they no longer stall behind in-flight HTTP/2 streams, and retry event-log reads whose HTTP/2 stream the peer reset.
