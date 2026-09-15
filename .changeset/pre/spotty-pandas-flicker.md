---
'@workflow/web-shared': patch
---

Fix the events view flashing a partial eventData stub (ref fields stripped by `resolveData: 'none'`) before the full payload loads; events whose type carries no payload ref fields now render their complete inline data immediately without a redundant fetch.
