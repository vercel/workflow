---
"@workflow/core": patch
---

On QuickJS, a spec 9 run that finishes while an inline step body is still running (the loser of a race against a sleep, a hook or another step) now writes its `run_completed` or `run_failed` without waiting for that body, whatever the run's retention, as node:vm and spec 8 runs already did. The body still settles before the delivery returns; on an `experimental_retention: 0` run the World discards what it writes after the purge.
