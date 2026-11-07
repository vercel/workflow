---
"@workflow/builders": patch
---

Compile JSX in project-local files bundled into a directly loaded steps bundle (Nitro dev, Vitest, NestJS ESM), so a step that imports a `.tsx` module no longer fails with `Unexpected token '<'`.
