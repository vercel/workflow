---
'@workflow/cli': minor
---

Add `wf inspect attributes`, which lists the attribute keys recorded on your runs with a run count and when each was first and last seen, and `wf inspect runs --attribute key=value` (repeatable) to filter runs by them.

`wf cancel` now resolves the plan's listing window once instead of once per status, removing a redundant request.

`wf inspect sleeps` now falls back to the event log when the analytics read is unavailable, rather than ending the command. Plan, access, and invalid-argument failures are still reported, since their messages tell you what to do.

`--limit`, `--runId` and `--attribute` are checked before any backend work, so a mistyped value or a flag given to a listing that cannot use it names the flag instead of being ignored, and an argument the read path rejects is now reported rather than raised as an unhandled error.
