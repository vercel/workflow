---
'@workflow/world-vercel': patch
---

Revert the deferred frame-buffer concatenation in `decodeFrames`: stashing yielded chunk views across `await`s let the stream reuse their backing buffers before the copy, corrupting encrypted frame payloads (vercel-world e2e and WS transport lanes failed fleet-wide). Chunks are copied on receipt again.
