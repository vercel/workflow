---
"@workflow/world-vercel": patch
---

Spec 9: watch the live feed with backend heartbeats. world-vercel lists the `run-heartbeat` WS flag. Against a backend that confirms heartbeats on `subscribe_ack`, a feed silent for three heartbeat intervals ends through `onError`, a heartbeat naming a slot the feed never delivered makes it read and deliver the missing events from the log, and a heartbeat for another subscription ends the feed.
