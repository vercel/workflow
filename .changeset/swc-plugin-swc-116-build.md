---
"@workflow/swc-plugin": minor
"@workflow/nest": minor
---

`@workflow/swc-plugin/swc-1.16` is a build of the Workflow SWC plugin that runs on `@swc/core` 1.16; the main export still runs on 1.15. `workflow-nest init` points `.swcrc` at the build that matches the `@swc/core` `nest build` loads, and warns when an existing `.swcrc` points at the other one.
