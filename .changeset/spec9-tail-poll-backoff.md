---
"@workflow/core": patch
---

Back off a spec 9 orchestrator's log-tail poll while no live feed covers the run: each empty poll doubles the interval from `WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS` up to 10 seconds, and a poll that delivers an event, a failed poll, feed trouble or a write by the delivery itself starts it over.
