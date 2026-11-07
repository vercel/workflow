---
"@workflow/world-vercel": patch
---

Keep idle queue connections for 60s instead of 10s, so instances that publish every 10-60s reuse a warm connection instead of paying a TCP and TLS handshake inside each send.
