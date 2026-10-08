---
"@workflow/world-vercel": patch
---

Start the queued branches of a wide `Promise.all` fan-out sooner on the Vercel World. A fan-out's queue messages are now published as concurrent requests of at most 4 messages instead of one request per batched write. The queue service delivers a request's messages later the more of them the request carried (about 45 ms after the request is accepted for 4 messages, 105 ms for 16), and a queued branch can't start before its message arrives. Set `WORKFLOW_VERCEL_QUEUE_SEND_BATCH_SIZE` to change the request size.
