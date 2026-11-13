---
"@workflow/world-vercel": patch
"@workflow/builders": patch
---

Remove the `WORKFLOW_SEQUENTIAL_REPLAYS` opt-in. Flow messages always go to the workflow's flow topic, and a spec 9 run's orchestrator messages are kept to one invocation at a time by world-vercel. `isSequentialReplaysEnabled()` is deprecated and always returns `false`, and the flow queue trigger never sets `maxConcurrency`.
