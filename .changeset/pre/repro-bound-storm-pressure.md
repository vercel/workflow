---
---

Internal: the event-log-race-repro harness now caps `step-storm`'s poke pressure per run, cancels runs it abandons at `runTimeoutMs` so they stop starving later scenarios, and records how far a `stuck` run got.
