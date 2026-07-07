---
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Expose `startTime`/`endTime` on `world.analytics.runs.list`. The workflow-server endpoint already accepts a bounded window (and is significantly faster with one, since it prunes the ClickHouse scan); this lets clients such as the CLI and web UI send it.
