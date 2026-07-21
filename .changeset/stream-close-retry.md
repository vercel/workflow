---
'@workflow/world-vercel': patch
---

Retry stream close on retriable 5xx. Unlike chunk appends (which are not
idempotent and deliberately never retry 5xx), closing a stream is
idempotent on the server — a duplicate close of a completed stream is a
no-op — and the server may surface transient close-time reconciliation
states as retriable 503s that expect the writer to close again. The
close call now uses its own dispatcher retrying 429 and 5xx with
Retry-After honored; chunk writes keep the narrowed no-5xx retry policy
unchanged.
