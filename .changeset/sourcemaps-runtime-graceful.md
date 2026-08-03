---
'@workflow/core': patch
---

Speed up workflow stack-trace remapping when source maps are absent (production default): skip bundle scanning when no frame references the workflow file and memoize parsed source maps per bundle.
