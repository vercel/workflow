---
'@workflow/world-local': patch
---

Skip the `chmod`-based permission tests when the process bypasses the permission bits (root / `CAP_DAC_OVERRIDE`), instead of failing the suite.
