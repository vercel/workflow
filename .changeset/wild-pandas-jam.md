---
'@workflow/core': patch
---

Re-dispatch a pending step whose queue message is gone, so a lost dispatch or an invocation that disappears mid-step no longer strands a run
