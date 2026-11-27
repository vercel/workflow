---
"@workflow/builders": patch
---

Point Node.js module errors at the first use of any binding the module is imported as, instead of dropping or misplacing the error when the first named import is unused or type-only.
