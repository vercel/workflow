---
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/cli': patch
'@workflow/web': patch
---

Show a run's usage on the Local World. The run page's header shows the run's full event count and its storage, and a new **Usage** tab shows where its events come from (the workflow, its steps with their calls, share and retries, then the run's own events, sleeps and hooks), and the data it wrote by entity. Local runs aren't billed, so the tab and the CLI say how many billable events the run would count as on Vercel. A run started with `experimental_retention: 0` reports what it wrote before its data was deleted. `workflow inspect run <id> --usage` prints the same numbers, and `--usage --json` prints them as JSON. World-local counts them with aggregate queries over the run's log (`world.experimental_usage`, an optional, experimental World method), and remembers each run's counts so polling a large live run does not hold up the web server.
