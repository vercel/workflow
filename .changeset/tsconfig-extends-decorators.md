---
"@workflow/builders": patch
"@workflow/next": patch
---

Read `experimentalDecorators` and `emitDecoratorMetadata` through tsconfig `extends` (including `extends` arrays and extensionless paths such as `./tsconfig.base`), so decorated classes in workflow and step files compile when the options live in a base config.
