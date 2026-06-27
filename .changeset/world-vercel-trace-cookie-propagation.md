---
'@workflow/world-vercel': patch
---

Propagate the caller's `_vercel_tracing` cookie as an `x-vercel-tracing` header on every queue message, so backend flow-route invocations are collected in Vercel's tracing dashboard (not just client-initiated requests). Requires the matching VQS header-forwarding support; no-ops when no request context or cookie is present.
