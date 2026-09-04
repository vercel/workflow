---
"@workflow/builders": patch
"@workflow/next": patch
---

Fix Next.js lazy discovery workflow IDs for monorepo workspace packages by resolving module specifiers relative to the app package instead of the tracing root.
