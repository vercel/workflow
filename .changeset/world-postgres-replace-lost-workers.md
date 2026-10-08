---
'@workflow/world-postgres': minor
---

Start a Graphile Worker runner in place of one that lost a worker to a failed job release, or that Graphile Worker stopped over an error, so database failovers no longer leave the queue claiming nothing, and report each loss through the new `onWorkerLost` option.
