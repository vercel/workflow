---
'@workflow/world-postgres': patch
---

Fix a race where a stream write in flight while a run finished could commit after the run's data was deleted, and stop serving stream bytes for a run whose data is deleted.
