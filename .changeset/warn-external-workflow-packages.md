---
"@workflow/builders": patch
---

Warn when `serverExternalPackages` contains packages with workflow code (`"use step"`, `"use workflow"`, or serialization classes). These packages will not be transformed by the workflow compiler when externalized, causing silent runtime failures.
