---
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Experimental shared affinity cells: with `WORKFLOW_AFFINITY_CELL_SIZE` set, new runs ask workflow-server to pack up to that many runs into one routing affinity. Invocations route with the affinity the server reported most recently for the run, and owners state it on their eventsync handshake. A retained owner whose stated affinity is rejected, or which is otherwise superseded during initialization, stops without writing a terminal failure.
