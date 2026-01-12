---
"@workflow/core": patch
---

Fix stream serialization to resolve when user releases lock instead of waiting for stream to close. This prevents Vercel functions from hanging when users incrementally write to streams within steps (e.g., `await writer.write(data); writer.releaseLock()`). Uses a polling approach to detect when the stream lock is released and all pending writes are flushed.

