---
'@workflow/builders': patch
---

Honour `config.externalPackages` in the combined and webhook esbuild passes, so a step that reaches an optional peer dependency no longer fails the build.
