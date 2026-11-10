---
"@workflow/ai": patch
"@workflow/astro": patch
"@workflow/builders": patch
"@workflow/cli": patch
"@workflow/core": patch
"@workflow/errors": patch
"@workflow/nest": patch
"@workflow/next": patch
"@workflow/nitro": patch
"@workflow/nuxt": patch
"@workflow/rollup": patch
"@workflow/serde": patch
"@workflow/sveltekit": patch
"@workflow/typescript-plugin": patch
"@workflow/utils": patch
"@workflow/vite": patch
"@workflow/vitest": patch
"workflow": patch
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/world-testing": patch
"@workflow/world-vercel": patch
---

Publish smaller packages: compiled tests and declaration maps are no longer included, `@workflow/world` no longer ships its TypeScript sources, and the inline source maps no longer embed the original sources. Stack traces still map to the original file, line and column.
