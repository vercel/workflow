---
"@workflow/core": patch
---

BREAKING: `resumeHook()` now throws errors (including when a Hook is not found for a given "token") instead of returning `null`
