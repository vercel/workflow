---
'@workflow/world-postgres': patch
---

Event IDs are now a dense per-run slot number, allocated inside the insert that occupies them so a rejected write leaves no gap in the event log. The migration replaces the event table's primary key and holds a lock while the new index builds; on a large table create `workflow_events_run_id_id_idx` with `CREATE UNIQUE INDEX CONCURRENTLY` first and the migration adopts it instead of building its own (see the comment at the top of `0019_add_event_slots.sql`).
