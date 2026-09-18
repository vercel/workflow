---
"@workflow/world": minor
"@workflow/core": minor
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/errors": minor
---

Add `createHook({ experimental_force: true })`, which takes a hook token over from the run that currently holds it instead of rejecting with `HookConflictError`. The previous owner's hook is disposed in its event log and the run is woken; if it was awaiting the hook, the promise rejects with the new `HookForceClaimedError` naming the run that took the token. `resumeHook()` callers are never affected: a delivery that resolved the token to the previous owner before the takeover is redirected to the new owner inside `resumeHook()`. The takeover is durable across mid-way failures, works across regions on the Vercel World, and is implemented by all three first-party Worlds. Hooks returned by `getHookByToken()` carry `claimedFrom` when they took their token from another run.

Add `createHook({ experimental_force: true })` option, which takes a hook token over from the run that currently holds it instead of rejecting with `HookConflictError`. Previous runs awaiting the hook are rejected with `HookForceClaimedError` naming the run that took the token. See [`experimental_force` docs](https://workflow-sdk.dev/v5/docs/api-reference/workflow/create-hook#take-over-a-token-another-run-holds) for details.
