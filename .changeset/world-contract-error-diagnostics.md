---
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Surface the actual validation failure when a world response is rejected. `decodeCreateEventResponse` (and the batch, max-events-header, and error-frame decoders) now include the Zod issue paths and codes in the thrown `WorkflowWorldError` message instead of only attaching them as an unlogged `cause`, and the runtime's terminal `Error while running workflow` log now prints the underlying error message and world error code alongside the classified `errorCode`. Previously a terminal-write schema rejection surfaced in production as a bare `WORLD_CONTRACT_ERROR` with no indication of which response field failed — undiagnosable, since the cleanup `run_failed` is rejected (run already completed) or its payload is encrypted at rest. Issue paths only; received values are never logged.
