---
"@workflow/swc-plugin": minor
"@workflow/typescript-plugin": minor
---

Allow synchronous functions to use `"use step"` directive. This enables using `"use step"` as a mechanism to strip Node.js-dependent code from the workflow VM bundle without requiring the function to be async.
