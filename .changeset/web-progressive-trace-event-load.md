---
'@workflow/web': patch
---

Make run-detail trace loading paint faster: the trace render was blocked on fetching the first 500 events in a single `events.list` round-trip, which dominates run-load time over the network. We now fetch a small first page (100 events) to render immediately and fill the rest in the background, cutting time-to-first-trace roughly in half on a typical connection.
