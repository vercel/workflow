---
"@workflow/world-local": patch
---

Throw an error when trying writing JSON that fails entity validation, and remove error when trying to read JSON that fails validation, replacing it with a warning. This unblocks UI/CLI when data is invalid.
