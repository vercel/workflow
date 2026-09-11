---
'@workflow/vitest': patch
---

Bundle project-local imports into the test step bundle instead of externalizing them, fixing module resolution errors when bundles are loaded by Node's native ESM loader
