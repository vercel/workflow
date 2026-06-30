---
'@workflow/core': patch
'@workflow/world': patch
---

Further harden event pagination code, failing cleanly when a page reports more results but adds no new events and would get stuck in a loop. Codifies the forward-progress guarantee in the `events.list` contract.
