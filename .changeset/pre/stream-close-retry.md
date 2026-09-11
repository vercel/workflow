---
'@workflow/world-vercel': patch
---

Retry stream close on retriable 5xx. Close is idempotent on the server (unlike chunk appends, which keep their no-5xx retry policy), and the server may return retriable 503s expecting the writer to close again.
