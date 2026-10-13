---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
---

Experimental single-owner runs. Where the deployment can host a run's owner (a World that implements `invoke`, the current deployment, a static workflow), `start()` marks the run with the reserved attribute `$experimentalSingleOwner` (`'{}'` routes it by its own ID; a caller may pass `{"vercelAffinity": ...}`). Every input — the start, hook resumes, wakes, step results and cancellation — is invoked on one owner, which keeps the workflow resident, validates transitions locally and writes the run's history through one serialized writer. The owner runs up to three step bodies itself and delivers the rest directly to other invocations; their results return through `invoke`. A queued wake for a run that has ended is acknowledged rather than redelivered. The World contract gains `queue.invoke` and an optional single-writer event session (`events.createWriteSession`).
