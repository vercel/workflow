---
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Keep a run started with `experimental_retention: 0` free of data after it ends: the bundled Worlds clear what a step still running when the run ended (a `Promise.race` loser) writes to it, and write no stream chunks to it.
