---
'@workflow/world-local': patch
---

Allocate an event slot at publish time rather than reserving it up front, so a rejected write leaves no gap in the event log
