---
"@workflow/core": patch
"@workflow/world": patch
---

Generate runId client-side in start() and simplify runId types

The `runId` is now generated client-side using ULID before serialization, rather than waiting for the server response. This simplifies the `Streamer` interface and `WorkflowServerWritableStream` to accept `string` instead of `string | Promise<string>` for `runId`.
