---
"@workflow/core": patch
---

Skip re-publishing a pending step's execution message on a later replay pass when this same invocation already published it (a fresh delivery still re-enqueues unconditionally).
