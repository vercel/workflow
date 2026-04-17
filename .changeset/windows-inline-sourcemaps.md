---
"@workflow/ai": patch
"@workflow/astro": patch
"@workflow/builders": patch
"@workflow/cli": patch
"@workflow/core": patch
"@workflow/errors": patch
"@workflow/next": patch
"@workflow/nest": patch
"@workflow/nitro": patch
"@workflow/nuxt": patch
"@workflow/rollup": patch
"@workflow/serde": patch
"@workflow/sveltekit": patch
"@workflow/typescript-plugin": patch
"@workflow/utils": patch
"@workflow/vite": patch
"@workflow/vitest": patch
"@workflow/web-shared": patch
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/world-vercel": patch
"workflow": patch
---

Use inline sourcemaps across all workspace packages to work around a Turbopack bug on Windows that caused the SWC worker to crash when reading external `.js.map` files in workspace-linked packages (paths were concatenated with mixed separators). This stabilizes the Windows E2E tests by avoiding the broken module graph state that caused `/api/workflows/start` to return 500 after the first sourcemap read failure. Extends the original fix from #352 (previously applied only to `@workflow/core` and `workflow`) to the shared base `tsconfig.json`.
