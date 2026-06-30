---
'@workflow/core': patch
'@workflow/builders': patch
---

Defer step module loading until step execution so module load failures are recorded as step failures instead of route 500s.
