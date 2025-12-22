---
"@workflow/world-local": patch
---

Fix race condition in streamer where close events arriving during disk reads would close the controller before data was enqueued. Close events are now buffered and processed after disk reads complete.

