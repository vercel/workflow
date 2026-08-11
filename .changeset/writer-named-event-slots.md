---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
'workflow': patch
---

Bind each event write on a slot-numbered run to the position its replay named, so a write that races another is rejected and retried instead of landing out of order.
