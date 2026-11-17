---
"@workflow/world-local": minor
---
Add a live event feed (`events.subscribe`) to the Local World, so a spec 9 run's orchestrator takes other writers' events at once and stays warm between quick follow-ups instead of replaying on every wake. A `run.wakeUp()` that waits behind a delivery, from this process or another, ends that delivery's linger, so it is still delivered at once.
