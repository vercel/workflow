---
"@workflow/builders": patch
---

Switch Vercel Build Output API and standalone builder output from CJS to ESM. Step bundles, workflow bundles, and webhook bundles now emit ESM format by default, preserving native `import.meta.url` support and eliminating the need for CJS polyfills. The intermediate workflow bundle (which runs inside `vm.runInContext`) remains CJS as required by the VM execution model.
