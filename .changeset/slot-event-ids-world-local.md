---
'@workflow/world-local': patch
---

Event IDs are now a dense per-run slot number, allocated at publish time so a rejected write leaves no gap in the event log.
