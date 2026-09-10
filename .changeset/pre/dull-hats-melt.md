---
'@workflow/core': patch
'@workflow/world': patch
---

Ignore duplicate events that a concurrent replay wrote for an entity the event log already records, instead of failing the run with a corrupted event log
