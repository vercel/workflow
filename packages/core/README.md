# @workflow/core

Core runtime package for [Workflow SDK](https://workflow-sdk.dev).

The CI benchmark suite in `e2e/benchmark.test.ts` measures time to first step,
fan-out, and sequential-step overhead. Streaming delivery performance is
measured in durabench; stream correctness remains covered by unit and E2E tests.

Steps wait for released stream writers to drain before recording completion,
then release idle transport resources when the World supports it. Reacquiring
the same writable remains supported. Aborting a public writable drains its
accepted prefix and disposes the underlying writer transport without closing
the shared server stream. Source failures in flushable readable pipes propagate
to the user-facing reader rather than leaving it waiting for more data.
Streams that finish draining after the inline wait budget expires do not force
an extra queued continuation unless other background operations remain pending.

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
Register in the workflow executor's host startup, never from workflow or step
code. Framework-specific support, hot-reload behavior, and stream cleanup are
documented in the [lifecycle hooks guide](https://workflow-sdk.dev/v5/docs/observability/lifecycle-hooks).

### Single-owner runs (experimental)

Runs are single-owner by default wherever the deployment can host their owner:
a World that can invoke it (`capabilities.invoke`), a run of this deployment's
own static (non-dynamic) workflows, and a spec version with attributes. `start()`
marks such a run with the reserved attribute `$experimentalSingleOwner`, whose
value `{}` routes it by its own run ID. A caller may pass the marker itself (with
`allowReservedAttributes: true`) to choose an affinity, for example
`{"vercelAffinity":"cell-0"}`; an explicit marker that cannot be hosted makes
`start()` throw. The marker is the only setting: there are no other options for
this model. Elsewhere (for example a World without invoke), runs take the
existing path.

A single-owner run's inputs go to one owner, which keeps the workflow resident
and writes through the World's single-writer event session. The value is opaque
to core; a World may route by it.

Core validates retries and step transitions locally and keeps terminal failure
on the same serialized writer. If persistence cannot record the failure,
diagnostics expose `terminalPersisted=false` instead of starting a competing
write path.

### Step placement

The owner runs at most three step bodies at a time itself. Further admitted
bodies (up to 100 outstanding per run) are delivered with the existing Queue
primitive as messages marked `input.executionMode: 'remote'`, which the World
delivers directly to another invocation rather than through a queue. A generated
step-only handler executes the admitted body and returns its result with
`invoke`; the Next.js integration serves it at `/.well-known/workflow/v1/step`.
An admitted attempt that produces no outcome within 60 seconds is superseded by
a native retry or failure event, including after the owner is replaced, so
bodies are at-least-once across attempts and side effects must stay idempotent.

The owner durably commits each step start before the body runs anywhere. A
worker uses the committed start descriptor, executes one body, and sends its
native serialized outcome to the owner; only the owner writes the journal. A
recovery wake is armed before admission. Worker redelivery first resolves
uncertain execution through the owner; transport delivery count is not a new
step attempt. Its event sink accepts only its own step outcome.

Direct delivery is tracked outside the serialized owner turn, so a synchronous
HTTP worker can await its result acknowledgement without deadlocking the owner.
Starts remain durable before any local or remote user code runs. Results are
acknowledged only after the owner's durability barrier. A delivery failure without
a committed outcome faults the run instead of silently falling back to a queue.
The existing durable delayed wake remains the recovery backstop for interrupted
attempts; it is not the overflow execution or result transport.

### Sleeps in a retained run (experimental)

Before a `wait_created` event commits, the owner enqueues the sleep's durable
wake: a plain run wake delayed until `resumeAt`. A committed wait therefore
always has a pending wake. Waits longer than one queue hop (about 23 h) chain
wakes with the remainder. The queue delivers a wake to the public flow route,
which relays it to the owner with `invoke` (affinity = run ID).

When a sleep ends within `WORKFLOW_RETAINED_LOCAL_TIMER_MS` (default 30,000 ms;
`0` disables) and before the function deadline, the owner also arms an
in-process timer that enters the same mailbox and completes the wait without a
queue round trip. The durable wake then arrives after the wait completed and is
a no-op. A pending local timer keeps the owner alive past its idle window. Each
owner pass re-arms the local timer for any pending wait that is now within
range, so a wake that arrives before the target simply waits in-process.

### Owner monitor (experimental)

Inputs delivered with `invoke` (run start, hook input, step result) have no
queue redelivery behind them. To recover an owner that is lost while it holds
in-process work (for example an inline step that crashes the process), the
owner keeps a durable **monitor wake** pending, using `queue()` with
`delaySeconds` and the ordinary run-wake payload:

- An activation input arms it, `WORKFLOW_RETAINED_MONITOR_MS` (default
  60,000 ms) ahead, before the input is acknowledged. It is deduplicated in
  memory, so later inputs skip it while one is pending.
- After each turn, the owner re-arms it while in-process steps remain. When
  none remain, the chain ends after its pending wake, which then costs one
  no-op wake.
- Whichever owner receives the wake runs an ordinary pass. A replacement owner
  replays and restarts inline steps whose previous owner is gone, within the
  step's attempt budget.

Remote steps and sleeps keep their own deadline wakes. A live owner never
expires its own running steps; only attempts whose owner is gone time out.

At its function deadline the owner **hands off instead of failing the run**.
About 10 s before the deadline it stops taking work: new inputs get a
retryable 503 and no new inline steps start. It then enqueues an immediate run
wake for the next owner invocation and retires. That owner replays and
restarts any cut-off inline step as its next attempt, so a step that always
outlives the deadline fails through its own retry budget.

