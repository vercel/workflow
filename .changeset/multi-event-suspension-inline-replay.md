---
"@workflow/core": patch
---

Continue in-process over a hook suspension without an extra `events.list` when it also wrote other events, resuming off the longest write delta once it holds every event the suspension committed.
