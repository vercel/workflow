---
'@workflow/cli': patch
---

Add `--since`/`--until` flags to `workflow inspect runs` (relative durations like `12h`/`7d` or timestamps) that send an explicit listing window to the analytics backend. Name-based lookups in `workflow start` and bulk `workflow cancel` now widen to the plan's full observability window when the backend's default recent-window listing misses, so workflows idle or sleeping for more than a day keep resolving.
