---
'@workflow/world': minor
'@workflow/core': minor
---

Step-execution queue messages now carry the run's immutable identity (`runContext`: deploymentId, specVersion, startedAt, rootRunId), letting the consumer start a queued step without the blocking `runs.get` round trip — the run-status early exit is enforced by the `step_started` claim instead, and only the fan-out's last completer fetches the full run row for its inline replay. Messages without the field keep the previous behavior.
