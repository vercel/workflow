---
'@workflow/core': patch
---

Fix replay divergence when a step result overtook an earlier sleep or hook delivery that was parked behind an unread hook's payload
