---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Retry failed queue deliveries for the full message retention window (about 24 hours on Vercel) before failing the run with `MAX_DELIVERIES_EXCEEDED`, instead of giving up after 48 attempts.
