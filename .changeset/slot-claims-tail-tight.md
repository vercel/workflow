---
'@workflow/core': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Take event slot claims one at a time against the event log's tail, so a replay that decided from a log missing an event is rejected instead of committing.
