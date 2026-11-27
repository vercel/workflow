---
'@workflow/world-postgres': patch
---

Fix reading the events of a run whose data was deleted (`experimental_retention: 0` or `deleteRuns()`): they now read back without `eventData` instead of failing to parse, which made every later message for the run fail and retry.
