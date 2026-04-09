---
"@workflow/builders": patch
---

Fix workflow graph hook detection for transformed bundles

- Recognize step declarations with `@__PURE__` annotations in `WORKFLOW_USE_STEP` access
- Detect `createHook`/`createWebhook` calls wrapped by transpiled `using` helper calls
