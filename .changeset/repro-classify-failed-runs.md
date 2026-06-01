---
---

Internal: the event-log-race-repro CI job now classifies polled run failures from the run's structured `error` (code + message) instead of a non-existent top-level field, so USER_ERROR/RUNTIME_ERROR/CORRUPTED_EVENT_LOG are categorised correctly and the regression row shows why a run failed.
