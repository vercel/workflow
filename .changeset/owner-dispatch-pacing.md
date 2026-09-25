---
"@workflow/core": patch
"@workflow/world-vercel": patch
---

Commit retained-owner step starts in durable prefixes of 50 and dispatch each prefix as soon as it commits, yielding to the event loop between remote dispatch requests. Publish eventsync connection phase timings for diagnostics.
