# @workflow/core

Core runtime package for [Workflow SDK](https://workflow-sdk.dev).

Steps wait for released stream writers to drain before recording completion,
then release idle transport resources when the World supports it. Reacquiring
the same writable remains supported. Aborting a public writable drains its
accepted prefix and disposes the underlying writer transport without closing
the shared server stream. Source failures in flushable readable pipes propagate
to the user-facing reader rather than leaving it waiting for more data.
Streams that finish draining after the inline wait budget expires do not force
an extra queued continuation unless other background operations remain pending.
In turbo mode, same-run writable stream arguments wait for run creation before
opening a writer session, flushing chunks, or closing; the step body can still
start optimistically. Forwarded writables owned by another run do not wait on
the receiving run's creation barrier.

Hook registration acknowledgements and token conflicts participate in replay
delivery ordering alongside step results, hook payloads, and sleep completions.
Concurrent branches awaiting `hook.getConflict()` preserve their step correlation
IDs when replaying an extended event history.

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

Register `onRunCompleted` and `onRunFailed` handlers with `registerLifecycleHooks`
from `workflow/api` for best-effort reporting of terminal transitions written by
your app. Handlers receive the workflow name without a backend read, a lazy `Run`
instance, and, for failures, an error hydrated from the persisted payload.
Callbacks are not retried; the event log remains the system of record.
Hook-property getters and reporting failures are isolated from terminal writes.
The callback's `waitUntil` scope also drains background operations for streams
hydrated from the persisted failure, including when a handler throws.
