---
"@workflow/world": minor
"@workflow/world-vercel": patch
"@workflow/core": patch
---

Add an optional run-scoped event write session and bind it to the retained owner
loop. Begin event-channel setup alongside snapshot reads, reuse the channel
across inputs and asynchronous steps, and dispose it when the owner retires.
Vercel event writers join WebSocket readiness before their first write instead
of racing channel setup and silently using HTTP. Commit ordering is unchanged.
