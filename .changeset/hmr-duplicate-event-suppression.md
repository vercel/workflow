---
'@workflow/next': patch
---

Suppress duplicate dev-watcher notifications instead of re-invalidating: source snapshots now record the file mtime alongside the content hash, so a repeated event for an already-consumed write is a no-op while a same-content rewrite still triggers a conservative rediscovery. Full rediscoveries also seed baselines for newly discovered files from the classifier's reads, so a freshly created file's duplicate events no longer force a second rebuild.
