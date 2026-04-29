---
"@workflow/next": patch
---

Add workflow world packages to Next.js `serverExternalPackages` so webpack/turbopack do not follow transitive `require()` calls into native modules (e.g. `@napi-rs/keyring` reached via `@vercel/queue` → `@vercel/oidc` → `@vercel/cli-auth`) when bundling route handlers
