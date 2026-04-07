---
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-vercel": patch
"@workflow/world-postgres": patch
"@workflow/core": patch
"@workflow/ai": patch
---

Add `getStreamChunks()` and `getStreamInfo()` to the Streamer interface, and `getTailIndex()` to the readable stream returned by `run.getReadable()`. `WorkflowChatTransport` now reads the `x-workflow-stream-tail-index` response header to resolve negative `initialStartIndex` values into absolute positions, fixing reconnection retries after a disconnect.
