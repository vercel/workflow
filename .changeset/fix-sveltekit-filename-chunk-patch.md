---
"@workflow/sveltekit": patch
---

Fix the adapter-node server chunk patch skipping chunks whose only `__filename`/`__dirname` declarations are rollup-renamed (e.g. `__filename$1`), which crashed the production server at boot when a bundled CJS dependency (like the TypeScript compiler pulled in via cosmiconfig) referenced the bare identifier.
