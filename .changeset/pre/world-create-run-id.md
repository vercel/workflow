---
"@workflow/world": minor
---

Add optional `createRunId(options?)` to the `World` interface and `region` to `QueueOptions`. Worlds can now mint custom run IDs (reading whichever start-option fields they recognise) and route messages to a specific region.
