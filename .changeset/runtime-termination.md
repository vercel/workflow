---
"@workflow/world": patch
"@workflow/world-vercel": patch
"@workflow/core": patch
---

Add an optional `World.onRuntimeTermination(listener)`: notice that the hosting platform has begun stopping this process's instance. A single-owner run's owner subscribes while active and, when notified, hands off as it does at its deadline (no new work, pending inputs answered retryably, a wake armed for the next owner) instead of idling until its own timeout while the instance can no longer receive requests. The Vercel World implements it by reading the function runtime's local readiness while subscribed: a stopping runtime answers 502 with its reason.
