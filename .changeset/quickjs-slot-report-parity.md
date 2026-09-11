---
'@workflow/core': patch
---

The QuickJS engine now reports its log position on writes and feeds its VM from the events a World returns on the response, matching the node:vm engine.
