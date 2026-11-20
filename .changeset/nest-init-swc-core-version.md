---
"@workflow/nest": patch
---

`workflow-nest init` warns when the `@swc/core` that `nest build` uses is missing or is not 1.15.x, and prints the install command for the project's package manager, run where `@nestjs/cli` is installed (the workspace root, in a monorepo that installs it there)
