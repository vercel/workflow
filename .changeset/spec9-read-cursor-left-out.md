---
'@workflow/core': patch
---

Fix a spec 9 run sometimes requiring a full event log reload when an incremental read of the event log moved its position past an event it did not take in when merging speculative writes.
