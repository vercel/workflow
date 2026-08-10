---
'@workflow/world-postgres': patch
---

The migration that switches event ids to slot numbers replaces the event table's primary key, which locks the table for the duration of the index build. On a large table, create `workflow_events_run_id_id_idx` with `CREATE UNIQUE INDEX CONCURRENTLY` first and the migration adopts it instead of building its own (see the comment at the top of `0019_add_event_slots.sql`).
