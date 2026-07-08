---
'@workflow/world-local': patch
---

Fix hook operations scaling with total event history: hook creation, hook cache rebuilds, and token lookups now use durable per-token/per-hookId indexes instead of scanning the entire global event log, and run-termination hook cleanup uses per-run markers instead of reading every live hook. Directory listings also read files concurrently and reuse compiled filename regexes.
