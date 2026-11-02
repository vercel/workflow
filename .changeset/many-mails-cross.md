---
"@workflow/core": patch
"workflow": patch
---

Read workflow `response.body` in replayable chunks that start at 64 KiB and grow with the bytes already read, so consumer size limits and cancellation take effect before the whole stored body is loaded. Cancelling a hydrated body after its stored stream has been fully read no longer fails the step.
