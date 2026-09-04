---
'@workflow/world-local': patch
---

Fix hook operations scaling with total event history: hook creation, hook cache rebuilds, and token lookups now use durable per-token/per-hookId indexes instead of scanning the entire global event log, and run-termination hook cleanup uses per-run markers instead of reading every live hook. Directory listings read files concurrently, `runs.list` defaults to a page size of 200, and compiled filename regexes are reused.
