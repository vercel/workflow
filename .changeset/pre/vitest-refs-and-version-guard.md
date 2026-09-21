---
'@workflow/vitest': minor
---

Emit the workflow manifest next to the test bundles and add `getWorkflowRef()` / `listWorkflowRefs()` so tests can name a workflow instead of hand-writing its generated id. The test build also fails up front when `@workflow/vitest` and the app resolve incompatible `@workflow/core` versions.
