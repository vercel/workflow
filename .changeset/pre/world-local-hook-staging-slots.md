---
'@workflow/world-local': patch
---

Fix `CORRUPTED_EVENT_LOG` after a hook resume that raced another writer or was interrupted mid-write, and deliver a raced resume exactly once instead of duplicating it or reporting a conflict.
