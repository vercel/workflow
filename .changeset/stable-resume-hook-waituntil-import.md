---
"@workflow/core": patch
---

Import `waitUntil` in `resume-hook.ts`, which used it without importing it. Unblocks `tsc` on the stable branch.
