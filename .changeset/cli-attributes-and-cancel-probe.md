---
'@workflow/cli': minor
---

Add `wf inspect attributes`, which lists the attribute keys recorded on your runs with a run count and when each was first and last seen, and `wf inspect runs --attribute key=value` (repeatable) to filter runs by them.

`wf cancel` now resolves the plan's listing window once instead of once per status, removing three requests from a typical run.
