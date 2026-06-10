---
"@workflow/core": patch
---

Fix process crash from unhandled rejection when a background event-create or stream-flush operation fails (e.g. a transient network error on POST /runs/{id}/events). Promises handed to `waitUntil` no longer rethrow; errors now propagate through the awaited path so the queue re-drives the message.
