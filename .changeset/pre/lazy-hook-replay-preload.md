---
'@workflow/world': minor
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Initialize lazy hook resume replay from the `hook_received` write via the new advisory `preloadEvents` param, skipping `run_started` and the initial `events.list`; safe fallback otherwise.
