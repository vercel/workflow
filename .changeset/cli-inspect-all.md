---
'@workflow/cli': minor
---

Improve `workflow inspect` for long runs and scoped lookups: add `--all` for complete steps, events, and sleeps listings, print reusable cursor hints, and keep pagination on the read path that issued the cursor. Support event ID and short workflow-name lookups, require `--runId` for individual steps, events, and streams, fix `st` to mean streams, include run IDs in stream hints, and exit non-zero when a stream read fails.
