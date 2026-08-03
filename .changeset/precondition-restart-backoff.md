---
'@workflow/core': patch
'workflow': patch
---

Space out in-process replay restarts with a randomized backoff so concurrent replays of one run stop contending in lockstep
