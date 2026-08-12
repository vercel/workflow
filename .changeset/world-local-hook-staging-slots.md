---
'@workflow/world-local': patch
---

Fix `CORRUPTED_EVENT_LOG` after a hook resume that raced another writer or was interrupted mid-write, and return the committed event to both writers of one resume instead of a conflict.
