---
"@workflow/world-vercel": patch
---

Start the queued branches of a wide `Promise.all` fan-out sooner on the Vercel World. A fan-out's queue messages are now published as concurrent requests of at most 4 messages, instead of one request per batched write of up to 16. The queue service delivers a request's messages later the more of them it carried: about 44 ms after the request is accepted at 4 messages, against 108 ms at 16. In production sweeps of a 64-branch fan-out, the last branch started about 65 ms sooner at p50 and 80 ms sooner at p75, with no change to the first branch or the join.
