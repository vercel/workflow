# Execution Model

A workflow is reconstructed by replaying deterministic orchestration against durable events, while steps isolate side effects in the ordinary host runtime.

## Workflows and Steps

Workflow and step functions deliberately have different semantics even when they are declared in the same source file.

A workflow function marked with `"use workflow"` is an orchestrator. It may branch, loop, compose promises, create hooks, sleep, start child workflows, and schedule steps, but it must remain deterministic under replay. The build places it in a sandboxed VM.

A step function marked with `"use step"` performs side effects. It runs with host APIs, has durable input and output, and may be retried. A workflow observes a step only through its event-backed promise, never by retaining the step's process state.

This split exists because replay can reproduce decisions only when every nondeterministic result is either made deterministic by the VM or recorded at a durable boundary.

## Replay Cycle

Each orchestration invocation walks the committed event log from the beginning or resumes an equivalent retained VM session, producing the same durable operation sequence.

During replay, durable primitives subscribe to the event stream using deterministic correlation IDs:

- If matching terminal events already exist, their persisted results are hydrated and delivered to workflow code.
- If a required event is absent, the primitive registers pending work.
- When workflow code can make no further progress, the runtime raises an internal suspension containing that work.
- The host materializes the work as events, executes eligible steps inline or queues them, schedules waits, and then replays again.
- Completion or an uncaught failure appends a terminal run event.

Suspension is internal control flow, not an application error. A workflow may suspend many times and on different compute instances without losing logical state.

## Determinism

Determinism means the same workflow code, input, and ordered event history must schedule and resolve the same logical operations in the same order.

The VM blocks arbitrary host access and provides deterministic forms of time, randomness, IDs, and supported globals. Correlation IDs are drawn from one replay-seeded monotonic sequence, so changes to branch order or call order are visible as divergence rather than silently binding an event to the wrong operation.

Promise delivery also follows event-log position. Hydration, decryption, hooks, waits, and VM microtasks can take different numbers of host turns; the runtime uses ordered queues and delivery barriers so those timing differences cannot change `Promise.race` winners or subsequent ID allocation.

An event that cannot be consumed by the replay indicates one of three conditions: an allowed out-of-band event arrived before its consumer, a duplicate transition must be ignored, or the workflow no longer matches its history. Parkable events wait for a later consumer; stranded or ordered mismatches trigger replay recovery and eventually a corruption failure.

## Step Ownership and Retries

A step body may begin only after one invocation wins the durable start claim for that step attempt.

The runtime can execute initial steps inline with orchestration to reduce latency or dispatch them through the queue. Both paths converge on World-enforced entity transitions and correlation identity. Competing deliveries either observe an existing claim or receive a conflict and skip the body.

Ordinary thrown errors retry up to the step's configured limit. `RetryableError` can request a delay; `FatalError` ends retrying immediately. A successful result or final failure is serialized into a terminal step event, and the next replay resolves or rejects the original workflow promise.

Optimizations such as lazy creation, batched fan-out, optimistic inline execution, and resilient dispatch do not weaken the ownership rule. They change when writes overlap, but the durable claim remains the authority for whether user code may run.

## Hooks and Waits

Hooks and waits are durable suspension points whose completions may originate outside the replay that created them.

A Hook claims a token and can receive one or many payloads. Each receipt is an event, so an iterator resumes in committed order. Explicit disposal and run termination prevent future delivery; optional retention can keep token ownership readable for a minimum period.

A wait records a stable deadline. Its delayed continuation wakes the workflow, and a `wait_completed` event resolves the sleep. Re-delivered or early continuations must converge without changing the deadline.

Because Hook receipts and wait completions race with steps and with each other, their delivery to workflow code is ordered by the event log rather than wall-clock completion inside a process.

## Completion and Cancellation

A run ends in exactly one terminal state: completed, failed, or cancelled.

Completion records the serialized return value. Failure records the serialized thrown value plus a plaintext classification code. Cancellation is an externally initiated event; workflows and steps may observe cancellation through durable abort plumbing, but already-started side effects still require application-level idempotency or compensation.

Terminal events close the workflow's durable lifecycle. Remaining streams are closed, Hooks can no longer be resumed, and later conflicting transitions must be rejected or treated as idempotent observations of the terminal state.

## Child Runs

Starting a workflow from a step creates a separate run rather than nesting execution state inside the parent log.

The child receives lineage attributes identifying its parent and root run. Awaiting the returned `Run` object is itself safe across replay because the handle is serializable and its result is read from the child's durable state. Worlds need enough worker capacity to avoid starving parents that wait on children.

Run boundaries are also upgrade boundaries: long-lived loops can intentionally start their successor on a newer deployment instead of changing code beneath an existing event history.
