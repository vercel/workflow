---
"@workflow/nest": patch
---

Mark the NestJS and SWC peer dependencies as optional, so installing `workflow` no longer pulls `@nestjs/core`, `@nestjs/common` and `@swc/cli` into projects that do not use NestJS. NestJS projects must now list `@swc/cli` and `@swc/core` in their own `devDependencies` (`npm i -D @swc/cli @swc/core`).`workflow-nest init` now warns when they are missing.
