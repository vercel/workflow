---
"@workflow/world": minor
"@workflow/core": minor
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/errors": minor
---

Add `createHook({ experimental_force: true })`, which takes a hook token over from the run that currently holds it instead of rejecting with `HookConflictError`. The previous owner's hook is disposed in its event log and the run is woken; if it was awaiting the hook, the promise rejects with the new `HookForceClaimedError` naming the run that took the token. `resumeHook()` callers are never affected: a delivery that resolved the token to the previous owner before the takeover is redirected to the new owner inside `resumeHook()`. The takeover is durable across mid-way failures, works across regions on the Vercel World, and is implemented by all three first-party Worlds. Hooks returned by `getHookByToken()` carry `claimedFrom` when they took their token from another run.

`start()` now stamps `executionContext.hookForceClaimReaderVersion` (`HOOK_FORCE_CLAIM_READER_VERSION`), attested by the deployment that will execute the run — the target's health-probe answer for a cross-deployment start — to record that its runtime reads a `hook_disposed` written by another run's takeover as an involuntary disposal. A token is only ever taken from a running victim carrying that stamp; for any other run (an older SDK release, a Python runtime, an unattested target) every World answers the forced creation with an ordinary `hook_conflict` (`forceRefusedReason: 'victim-runtime'`), so no run started by an earlier release can be stranded on `await hook`. The spec version is unchanged. The previous owner's wake is republished on the new owner's replays until it records its next event, so a crash between registering the hook and publishing the wake is repaired by the next invocation.
