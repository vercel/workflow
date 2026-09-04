---
'@workflow/core': patch
'@workflow/world': patch
---

Make `resumeHook()` durable before it resolves: the `hook_received` event is
written durably first, and the workflow wake is published only after the write
is acknowledged. A disposal racing the queue delivery can no longer lose a
resume the caller was told succeeded. The wake message is unchanged, so no
consumer or backend coordination is needed; `WORKFLOW_DISABLE_LAZY_HOOK_RESUME`
is now a no-op and the internal `resumeHookDurable()` alias is removed.

Behavior changes: a resume against an ended run now throws `HookNotFoundError`
instead of resolving (the lazy path never observed the server's rejection, so a
late webhook delivery to a finished run answered 202 where it now answers 404).
A transient write conflict (HTTP 409, e.g. an event-slot conflict under
contention) is no longer re-keyed to `HookNotFoundError`: it surfaces as a
retryable error, since its transaction committed nothing.
