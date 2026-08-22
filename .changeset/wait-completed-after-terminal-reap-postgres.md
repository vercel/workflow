---
'@workflow/world-postgres': patch
---

Accept `wait_completed` for a wait whose row the run's terminal transition deleted, recording the event without recreating the row and deduplicating against the event log
