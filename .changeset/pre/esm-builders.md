---
"@workflow/builders": patch
"@workflow/cli": patch
---

Switch Vercel Build Output API and standalone builder output from CJS to ESM. Step bundles, workflow bundles, and webhook bundles now emit ESM format by default, preserving native `import.meta.url` support and eliminating the need for CJS polyfills. Fully-bundled ESM output includes a `createRequire` banner to support CJS dependencies that use `require()` for Node.js builtins. The intermediate workflow bundle (which runs inside `vm.runInContext`) remains CJS as required by the VM execution model.
