---
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Reject `hook_received` on terminal runs, including when the termination commits concurrently (cross-process) and for legacy (pre-event-sourcing) runs.
