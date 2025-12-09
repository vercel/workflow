---
"@workflow/next": patch
"@workflow/builders": patch
"@workflow/rollup": patch
---

Add support for `.mjs`, `.mts`, `.cjs`, and `.cts` file extensions in the SWC transform

- Updated turbopack rules to include `*.mjs`, `*.mts`, `*.cjs`, `*.cts` in addition to existing extensions
- Fixed TypeScript detection for `.mts` and `.cts` files across all transform plugins
- Updated esbuild `resolveExtensions` to include `.mts` and `.cts`
- Updated the file watcher's `watchableExtensions` to include `.cts`
