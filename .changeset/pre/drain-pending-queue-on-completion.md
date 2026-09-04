---
"@workflow/core": patch
---

Drain pending queue items at workflow completion instead of only logging warnings, and implicitly dispose any never-aborted system (abort) hooks at completion so unused `AbortController` instances don't leave abandoned rows in the hooks table for the run's TTL
