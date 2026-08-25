---
'@workflow/builders': patch
---

Deduplicate identical pnpm peer-variant copies of a package instead of failing the build with a duplicate step/workflow ID error. Genuinely different implementations that map to the same ID still fail.
