---
'@workflow/world-local': minor
---

Support atomic start Hook admission: admitting a run creates its start Hook, which is resumable at once; the run keeps its token until it ends, even after disposing the Hook.
