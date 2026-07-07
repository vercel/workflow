---
"@workflow/sveltekit": patch
"@workflow/builders": patch
---

Fix the SvelteKit production server crashing at boot when a world package pulls cosmiconfig into the server bundle: alias the TypeScript compiler to a stub (bundling converts cosmiconfig's lazy `require('typescript')` into an eager evaluation, executing the entire compiler at boot and shrinking the server output by ~25MB once removed), and fix the adapter-node chunk patch skipping chunks whose only `__filename`/`__dirname` declarations are rollup-renamed (e.g. `__filename$1`) while a bundled CJS dependency references the bare identifier.
