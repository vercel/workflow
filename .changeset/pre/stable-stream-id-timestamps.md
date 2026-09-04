---
'@workflow/core': patch
'workflow': patch
---

Fix stream IDs minted while serializing a step's arguments latching the host wall clock into a run's ID sequence, which gave every entity created afterwards a different correlation ID on each replay
