---
'@workflow/world-vercel': patch
---

Propagate the caller's Vercel trace-session JWT as an `x-vercel-tracing` header on every queue message, so backend flow-route invocations are collected in Vercel's tracing dashboard (not just client-initiated requests). The JWT is read from the `_vercel_tracing` cookie (browser-initiated `start()`) or the VQS-forwarded `x-vercel-tracing` header (server-to-server re-enqueue). Requires the matching VQS header-forwarding support (vercel/vqs-server#619) and the proxy's `ENABLE_TRACE_SESSION_HEADER`; no-ops when no request context or trace context is present.
