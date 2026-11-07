---
"@workflow/nest": patch
---

Mark the NestJS and SWC peer dependencies as optional, so installing `workflow` no longer pulls `@nestjs/core`, `@nestjs/common` and `@swc/cli` into projects that do not use NestJS.
