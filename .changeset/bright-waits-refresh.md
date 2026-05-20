---
'@workflow/core': patch
'workflow': patch
---

Reload workflow events after completing elapsed waits so concurrent hook events preserve deterministic replay order.
