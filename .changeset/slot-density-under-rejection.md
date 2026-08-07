---
'@workflow/world-postgres': patch
---

Allocate event slots inside the insert that occupies them, so a rejected write leaves no gap in the event log
