---
"@workflow/core": patch
"@workflow/web-shared": patch
"@workflow/web": patch
"@workflow/cli": patch
---

Extract browser-safe serialization format from `@workflow/core` and split o11y hydration by environment. Data hydration now happens client-side in the browser, enabling future e2e encryption support.
