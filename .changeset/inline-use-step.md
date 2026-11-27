---
"@workflow/builders": patch
"@workflow/next": patch
---

Find `"use step"` and `"use workflow"` when the directive shares a line with other code, such as `async function doWork(i) { "use step"; return i * 2; }`. The build used to skip these functions without a warning, so the step was missing from the deployment.
