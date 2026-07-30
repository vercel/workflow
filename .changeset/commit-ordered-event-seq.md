---
'@workflow/world': minor
'@workflow/world-postgres': minor
'@workflow/core': minor
'@workflow/web-shared': patch
---

Commit-ordered event positions: events gain an optional dense per-run `seq` assigned at the commit point under a per-run append serializer, so log order == commit order and cursor readers can never skip a late-committing event. world-postgres assigns positions transactionally (advisory-lock append serializer, tail-dominant event ids) and enforces the `stateEventCount` precondition snapshot as a transactional currency fence (412 rolls back the entity mutation with the event). The runtime asserts `seq` contiguity on event loads, turning a storage-ordering bug into an immediate failure instead of a silent replay divergence.
