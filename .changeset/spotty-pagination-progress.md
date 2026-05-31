---
'@workflow/core': patch
---

Further harden event pagination code, failing cleanly when a page reports more results but adds no new events and would get stuck in a loop
