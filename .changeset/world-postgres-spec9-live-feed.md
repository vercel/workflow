---
"@workflow/world-postgres": minor
---

Spec 9: add `events.subscribe` over LISTEN/NOTIFY, so a spec 9 orchestrator sees other writers' events at once and lingers on the feed; coalesce a run's orchestrator messages that queue behind its running delivery into re-runs of it; give a handoff the front of the run's queue; count a fence-refusal redelivery toward the delivery cap; and move an unstamped orchestrator message of a spec 9 run to the run's named queue.
