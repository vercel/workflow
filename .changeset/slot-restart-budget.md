---
'@workflow/core': patch
'workflow': patch
---

Let a run that numbers its events by position absorb more concurrent-write rejections in one invocation, instead of falling back to a delayed re-invocation
