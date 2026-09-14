---
---

Add a `cycle-hook` scenario to the event-log-race-repro harness: a per-cycle hook raced against a sleep, so a hook write lands while an abandoned wait is still open.
