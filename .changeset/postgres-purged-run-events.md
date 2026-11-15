---
'@workflow/world-postgres': patch
---

Fix reading the events of a run whose data a zero-retention purge deleted: they now read back without `eventData` instead of failing to parse, which made every later message for the run fail and retry.
