---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Exclude inline step execution from the workflow replay timeout. Long-running steps no longer hit `REPLAY_TIMEOUT` (fixes #2009). Adds a `WORKFLOW_REPLAY_TIMEOUT_MS` env var override and a new optional `World.processExitTriggersQueueRedelivery` capability used to gate the runtime's `process.exit(1)` failure path.
