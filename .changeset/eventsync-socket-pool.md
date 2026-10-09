---
"@workflow/world-vercel": patch
---

Experimental pre-opened eventsync sockets (`WORKFLOW_EVENTSYNC_POOL=<n>`): each process keeps up to `n` unassigned sockets to the server's unassigned eventsync route. A run's connection takes one and assigns it with an `attach` frame instead of upgrading; the socket is closed on release and replaced.
