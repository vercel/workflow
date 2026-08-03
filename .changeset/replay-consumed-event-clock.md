---
"@workflow/core": patch
---

Prevent replayed workflows from advancing their deterministic clock when a future event is inspected before its matching operation is invoked.
