---
"@workflow/world-local": minor
"@workflow/world-postgres": patch
---

world-local (spec 9): coalesce a run's orchestrator messages that queue behind its running delivery into re-runs of it (up to 32, with the same `attempt`, the next `deliveryCount`, the same `invocationStartedAt`, and the resume timing of an absorbed hook wake; a `run.wakeUp()` message is never coalesced, so `waitForSleep()` then `wakeUp()` stays reliable); keep the run's gate across a handoff, whose redelivery covers the messages waiting behind it; and resolve an unstamped orchestrator message's spec from the run, so a spec 9 run's message from an older SDK is serialized with the run's other deliveries.
