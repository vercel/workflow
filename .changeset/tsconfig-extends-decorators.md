---
"@workflow/builders": patch
---

Read `experimentalDecorators` and `emitDecoratorMetadata` through tsconfig `extends` (including `extends` arrays), so decorated classes in workflow and step files compile when the options live in a base config.
