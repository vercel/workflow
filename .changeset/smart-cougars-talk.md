---
"@workflow/core": patch
"workflow": patch
---

Add `hook.dispose()` method to explicitly release hook tokens for reuse by other workflows while the current workflow is still running
