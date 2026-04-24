---
"@workflow/core": patch
---

Remaining internal invariants (missing `startedAt`, VM `crypto.subtle.generateKey`, closure-vars outside a step context, `ENOTSUP`) now throw `WorkflowRuntimeError` so they are attributed to the SDK. `defineHook().resume()` formats schema validation failures as a readable bulleted list instead of a raw JSON dump.
