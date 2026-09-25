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

With a compatible single-owner World, `WORKFLOW_OWNER_JOURNAL=1` marks newly
created retained-owner runs for journal-only persistence. Core validates retries
and step transitions locally and keeps terminal failure on the same serialized
writer. If persistence cannot record the failure, diagnostics expose
`terminalPersisted=false` instead of starting a competing write path.

### Queued steps in a retained run (experimental)

`start(workflow, args, { experimental_stepExecution: { mode: 'queued' } })`
persists an immutable queued-step policy on a new retained run. This requires an
invoke-capable World and the current deployment as the target. The optional
`attemptTimeoutMs` defaults to 60,000 (range 1,000–900,000). Existing runs keep
their execution policy. Up to sixteen admitted bodies can be outstanding per run.

The owner durably commits step creation/start before publishing through the
existing Queue API. The generated flow handler selects the worker branch before
creating a retained owner. A worker uses the committed start descriptor, executes
one body, and sends its native serialized outcome to the owner using `invoke`.
Only the owner writes the journal; results and downstream bodies wait for its
durable prefix. No extra World capability or compiler transform is needed.

A recovery wake is armed before admission to cover the commit-to-publish gap.
Worker redelivery first resolves uncertain execution through the owner; transport
delivery count is not a new step attempt. Lost result acknowledgements reuse the
serialized outcome while it remains cached in the worker. Recovery reconstructs
outcome identities from canonical history. Expired attempts are superseded by
native retry/failure events; bodies are at-least-once across attempts. Application
side effects must therefore remain idempotent. Native payload/queue limits apply.

The worker reuses native hydration, serialization, error/retry and stream-op
handling. Its event sink accepts only its own step outcome; arbitrary workflow
event writes from a worker are rejected. Key and payload APIs remain available
for capabilities outside the owner event channel.

### Three-local-step overflow (experimental)

`experimental_stepExecution: { mode: 'hybrid' }` keeps at most three concurrent
step bodies in the retained owner and admits up to 100 outstanding bodies per
run. Overflow uses the existing Queue delivery primitive with
`input.executionMode: 'remote'`; the backend must implement direct execution for
these messages rather than publishing them to a queue. A generated step-only
handler executes the admitted body and returns its result with `invoke`.

Direct delivery is tracked outside the serialized owner turn, so a synchronous
HTTP worker can await its result acknowledgement without deadlocking the owner.
Starts remain durable before any local or remote user code runs. Results are
acknowledged only after the owner's durability barrier. A delivery failure without
a committed outcome faults the run instead of silently falling back to a queue.
The existing durable delayed wake remains the recovery backstop for interrupted
attempts; it is not the overflow execution or result transport.
