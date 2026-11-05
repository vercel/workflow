---
"@workflow/world": patch
"@workflow/world-vercel": patch
"@workflow/core": patch
---

Spec 9: watch the world-vercel live feed with backend heartbeats. world-vercel announces the `run-heartbeat` WS flag; against a backend that confirms heartbeats on `subscribe_ack`, a feed silent for three heartbeat intervals fails, a heartbeat naming a slot the client never received triggers a log read (`EventsSubscribeOptions.onGap`), and a heartbeat for another subscription ends the feed. While a feed is watched (`onWatched`), the orchestrator's live-feed poll runs at 60 seconds instead of 10, unless `WORKFLOW_ORCHESTRATOR_FEED_POLL_INTERVAL_MS` is set.
