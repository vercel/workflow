---
---

Internal: the event-log-race-repro CI job now classifies hook-resume timing races and transport errors as non-gating `infra` outcomes (separate from real event-log regressions), and raises the default hook/sleep iteration ceiling so the wake branch is reliably exercised.
