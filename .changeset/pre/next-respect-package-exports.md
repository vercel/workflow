---
"@workflow/next": patch
---

Stop rewriting workspace-package `/dist/` paths to `/src/` during workflow/step discovery so that the discovered file paths agree with how base-builder resolves the same packages through `pkg.exports`, fixing `Step function not registered` errors at runtime.
