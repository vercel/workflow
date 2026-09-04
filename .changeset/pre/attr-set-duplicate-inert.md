---
'@workflow/world': patch
'@workflow/core': patch
---

Fix runs failing with `CORRUPTED_EVENT_LOG` after every step had already succeeded, when the event log held two attribute writes under one id.
