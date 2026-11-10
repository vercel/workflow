---
'@workflow/world-vercel': patch
---

Record why an event write that tried the run's events WebSocket went over HTTP: the HTTP span carries `workflow.events.transport_fallback`, `no_channel` when the run had no socket or `connecting` for a `run_started` written during the handshake. Writes that never tried the socket carry no such attribute.
