---
"@workflow/world-vercel": patch
---

Fix `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH` by retrying HTTP stream appends with fresh bodies after confirmed 429s, using the shared throttle wait policy. Retry only connection-refused, DNS, and connect-timeout failures; surface other transport errors without replay.
