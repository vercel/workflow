---
'@workflow/core': patch
---

Fix aborts raised inside a step being dropped on the QuickJS engine when the abort controller's hook was created in the same suspension.
