---
'@workflow/core': patch
---

Fix an issue with the workflow's deterministic clock tracking advancement on consumption, not on write, which could lead to a determinism issue when concurrent replays called `Date.now` with different amounts of events read from the log
