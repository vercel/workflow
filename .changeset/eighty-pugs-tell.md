---
'@workflow/nitro': patch
'@workflow/nuxt': patch
'@workflow/vite': patch
---

Fix Vite virtual modules in step bundles by awaiting plugin initialization and using Vite's complete server transform pipeline in development. Rebuild only once when a workflow or one of its dependencies changes.
