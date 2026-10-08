---
'@workflow/cli': patch
---

The `workflow inspect` stream hints now include `--runId`, filled in with the listed run, and the streams table prints one. `workflow inspect stream <stream-id>` without `--runId` fails before contacting the backend, with the usage.
