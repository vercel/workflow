---
"@workflow/builders": patch
---

Override `"sideEffects": false` from `package.json` for discovered workflow/step/serde entries so esbuild does not drop their bare imports from the virtual entry
