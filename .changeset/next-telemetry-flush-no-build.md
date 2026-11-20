---
"@workflow/next": patch
---

Skip the workflow build when Next's telemetry helper (`detached-flush.js`) evaluates `next.config`, so the helper that `next dev` spawns on exit no longer starts the dev watcher and stays running.
