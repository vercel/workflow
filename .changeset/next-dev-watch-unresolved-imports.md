---
'@workflow/next': patch
'@workflow/builders': patch
---

Fix `next dev` not bundling a workflow that is created after its import, or deleted and restored
