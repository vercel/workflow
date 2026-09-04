---
'@workflow/world-vercel': minor
---

Default the events transport to WebSockets. `WORKFLOW_EVENTS_TRANSPORT=http`
opts back out; any other value, including unset, now takes the socket.
