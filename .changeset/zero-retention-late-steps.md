---
'@workflow/core': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Keep a run started with `experimental_retention: 0` free of data after it ends: its inline steps still running (a `Promise.race` loser) settle before the run's terminal event, and the bundled Worlds clear what a step writes to such a run after it ended, and write no stream chunks to it.
