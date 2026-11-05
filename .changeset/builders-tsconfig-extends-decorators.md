---
"@workflow/builders": patch
---

Follow `extends` when reading decorator options from tsconfig. A project that set `experimentalDecorators` in an extended config (for example a shared `tsconfig.base.json`) had decorators disabled in the SWC transform, so every decorated class failed with `SWC transform failed: Expression expected`.
