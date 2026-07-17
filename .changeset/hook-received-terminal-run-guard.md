---
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Fix `hook_received` being appended after a concurrent run termination by re-checking run status at the event-write linearization point.
