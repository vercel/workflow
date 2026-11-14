---
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/cli': patch
'@workflow/web': patch
---

Show a run's usage on the Local World. The run page's header shows the run's full event count and its storage, and a new **Usage** tab shows where its events come from, its retries, and the data it wrote by entity. `workflow inspect run <id> --usage` prints the same numbers, and `--usage --json` prints them as JSON. World-local counts them with aggregate queries over the run's log (`world.experimental_usage`, an optional, experimental World method).
