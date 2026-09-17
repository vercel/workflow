---
"@workflow/world": minor
"@workflow/core": minor
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/errors": minor
---

Add `createHook({ experimental_force: true })`, which takes a hook token over from the run that currently holds it instead of rejecting with `HookConflictError`. The previous owner's hook is disposed in its event log and the run is woken; if it was awaiting the hook, the promise rejects with the new `HookForceClaimedError` naming the run that took the token. `resumeHook()` callers are never affected: a delivery that resolved the token to the previous owner before the takeover is redirected to the new owner inside `resumeHook()`. The takeover is durable across mid-way failures, works across regions on the Vercel World, and is implemented by all three first-party Worlds. Hooks returned by `getHookByToken()` carry `claimedFrom` when they took their token from another run.

Runs are now stamped at spec version 8 (`SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM`): a runtime at this version reads a `hook_disposed` written by another run's takeover as an involuntary disposal. A token is only ever taken from a running victim stamped at 8 or later; for an older run every World answers the forced creation with an ordinary `hook_conflict` (`forceRefusedReason: 'victim-spec-version'`), so no run started by an earlier release can be stranded on `await hook`. The previous owner's wake is republished on the new owner's replays until it records its next event, so a crash between registering the hook and publishing the wake is repaired by the next invocation.
