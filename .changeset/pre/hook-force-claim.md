---
"@workflow/world": minor
"@workflow/core": minor
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/errors": minor
---

Add `createHook({ experimental_force: true })` option, which takes a hook token over from the run that currently holds it instead of rejecting with `HookConflictError`. Previous runs awaiting the hook are rejected with `HookForceClaimedError` naming the run that took the token. See [`experimental_force` docs](https://workflow-sdk.dev/v5/docs/api-reference/workflow/create-hook#take-over-a-token-another-run-holds) for details.
