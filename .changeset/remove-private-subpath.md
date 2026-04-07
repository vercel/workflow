---
"@workflow/core": patch
"workflow": patch
---

**BREAKING CHANGE**: Remove `@workflow/core/private` and `workflow/internal/private` public subpath exports. The SWC compiler plugin no longer generates imports from these paths.
