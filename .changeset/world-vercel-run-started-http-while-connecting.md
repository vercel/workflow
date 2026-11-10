---
'@workflow/world-vercel': patch
---

Write `run_started` over HTTP while the run's events WebSocket is still connecting, instead of waiting for the handshake. A delivery writes it first, as the flow route's socket is still opening, and every later write of the delivery waits for it (on spec 9 it gates turbo's first creation batch and step 1's outcome). The handshake keeps going for the writes after it; a socket that is already open still carries `run_started`.
