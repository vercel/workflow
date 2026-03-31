---
'@workflow/core': patch
'@workflow/errors': patch
---

Fix workflow/step not found errors to fail gracefully instead of causing infinite queue retries
