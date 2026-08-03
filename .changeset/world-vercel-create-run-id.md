---
"@workflow/world-vercel": minor
---

Implement `World.createRunId` to mint region-tagged ULIDs, preferring an explicit `options.region` from `start()`, then the `VERCEL_REGION` environment variable, and finally defaulting to `iad1` so run IDs are always tagged with a concrete, routable region. The queue now routes each message to the region encoded in the payload's tagged run ID (or to an explicit `opts.region` override), instead of the previous hard-coded `iad1`.
