---
'@workflow/core': patch
'workflow': patch
---

Give each kind of entity a workflow creates its own sequence of correlation IDs, so an extra hook or sleep no longer renumbers every step after it
