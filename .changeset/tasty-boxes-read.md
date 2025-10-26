---
"@workflow/world-postgres": patch
---

The dist/ folder is missing from 4.0.1-beta.1 which makes the package unusable. This change adds a prepublishOnly script to build the package when published.
