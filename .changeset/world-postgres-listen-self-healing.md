---
'@workflow/world-postgres': patch
---

Make stream delivery durable across `LISTEN`/`NOTIFY` interruptions: the dedicated `pg.Client` now reconnects with bounded exponential backoff (250 ms → 30 s), and `streams.get` runs a periodic re-query of `streams WHERE chunk_id > lastChunkId` as a polling safety net for chunks delivered while the LISTEN socket was down. The poll interval is configurable via `PostgresWorldConfig.streamPollIntervalMs` (default 5000 ms; set to 0 to disable). Tracks vercel/workflow#1855.
