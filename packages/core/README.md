# @workflow/core

Core runtime package for [Workflow SDK](https://workflow-sdk.dev).

Failed-run logs include underlying error causes and codes to help diagnose failures such as socket, DNS, and TLS errors. Unreadable causes are marked without preventing the run from being recorded as failed.

Queued step messages carry immutable run identity in `runContext`, so step
execution skips the initial `runs.get` and fetches the run row only when
continuing into workflow replay. Messages from older producers without
`runContext` retain the initial fetch.

When a World advertises `capabilities.invoke`, `resumeHook()` sends serialized
hook inputs through `world.invoke()` and waits for the executor's decision. The
World calls the existing handler with `invoke: true`, `requestId`, and the hook
input. Core validates the input, waits for its event write, and returns a
decision. Core shares a run's activity state between workflow execution and these
input calls.

The event write completes before the response is stored. On Worlds with
`hookResumeDedup`, a stable request identity makes retries reuse the same hook
event, including after hook disposal or run completion. Core can process inputs
while inline steps wait. Workflow code observes committed inputs at replay
boundaries, reusing a retained Node virtual machine when available.

Errors returned by the executor propagate through `world.invoke()` to the caller
of `resumeHook()`.
