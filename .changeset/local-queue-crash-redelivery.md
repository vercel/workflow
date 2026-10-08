---
'@workflow/world-local': minor
---

`start()` delivers again the queue messages a process died while delivering, with the same message ID and a higher attempt, before it re-enqueues active runs. Once `start()` has run, the queue journals each message under the data directory (`queue/`) until it's acknowledged; with `recoverActiveRuns` off it keeps no journal.
