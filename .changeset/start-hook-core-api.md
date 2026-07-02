---
"workflow": minor
"@workflow/core": minor
"@workflow/errors": minor
"@workflow/world": minor
"@workflow/web-shared": patch
"@workflow/cli": patch
"@workflow/world-vercel": patch
---

Add the experimental `hook` option to `start()`. Worlds that declare `startHookAdmission` reserve the hook token atomically with queue-first run admission: duplicate starts throw `HookConflictError`, and a queued run whose admission cannot be confirmed throws the new `WorkflowStartError`. Without `experimental_ttl` the token is released when the run ends. Queue failures on every `start()` path are now surfaced as `WorkflowStartError` (stage `queue`) instead of raw transport errors.
