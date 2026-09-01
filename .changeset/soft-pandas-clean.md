---
'@workflow/world-postgres': minor
---

Implement `experimental_retention: 0` in the Postgres World. When a run whose attributes carry `$retention: '0'` reaches a terminal state, its user payloads are cleared: the run's own input, output and error, its steps' input, output and error, its events' payloads, its hooks' metadata and resume context, and its stream chunk contents. Both halves of every payload column go — the CBOR one and its legacy JSON twin — so nothing survives in the column that a reader would otherwise still find. The rows themselves are kept, so a purged run stays listable and its history stays walkable.

The purge runs in a single transaction and stamps `expiredAt` alongside the cleared columns, so no reader can observe a half-purged run. It commits before the terminal `NOTIFY`, so a waiter woken by that notification re-reads an already-expired run.

Every other value keeps the data — an absent attribute, `'default'`, a non-zero duration (whose unit is not decided yet, so no World can honor it), and anything malformed. Deleting data on the strength of a value the World does not understand is the one failure that cannot be undone.
