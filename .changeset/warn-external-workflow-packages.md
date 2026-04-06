---
"@workflow/builders": patch
"@workflow/next": patch
---

Auto-remove workflow-enabled packages from Next.js `serverExternalPackages` so they can be transformed, and retain a best-effort `externalPackages` warning fallback for non-Next builders.
