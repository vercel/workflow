---
'@workflow/world-vercel': patch
---

Read live streams from the v3 endpoint so reads transparently reconnect when the server's max-duration timeout fires, instead of silently truncating long-lived streams.
